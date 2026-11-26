import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { cli, onMessage, op, send } from '../api';
import { getState, setState, toast, useStore } from '../store';
import { Icon, Markdown, StatusDot, STATUS_LABEL, dialog, useDebounced } from '../ui';
import { XTerm } from './XTerm';
import { ChatView } from './ChatView';
import type { BandData, DrawingData, NoteData, PalcoNode, PortalData, TerminalData } from '../types';

export interface NodeDataIn<T = unknown> {
  node: PalcoNode<T>;
  wsId: string;
  [k: string]: unknown;
}

const NOTE_COLORS: Record<string, string> = {
  yellow: '#f5d76e', blue: '#8ec5ff', green: '#9be3b0', pink: '#f7a8c9', purple: '#c9b3ff', orange: '#ffbf80', gray: '#c9ccd1',
};
export const noteColor = (c: string) => NOTE_COLORS[c] ?? c;

function Ports() {
  return (
    <>
      <Handle type="source" position={Position.Left} id="l" className="port" />
      <Handle type="source" position={Position.Right} id="r" className="port" />
    </>
  );
}

const update = (wsId: string, nodeId: string, data: Record<string, unknown>) =>
  op('node.update', { wsId, nodeId, patch: { data } }).catch((e) => toast((e as Error).message));

async function rename(wsId: string, node: PalcoNode<{ name: string }>) {
  const r = await dialog('Renomear', [{ key: 'name', label: 'Nome', value: node.data.name }]);
  if (r?.name?.trim()) await update(wsId, node.id, { name: r.name.trim() });
}

async function remove(wsId: string, node: PalcoNode, what: string) {
  const r = await dialog(`Remover ${what} "${(node.data as { name?: string }).name ?? ''}"?`, [], { submit: 'Remover', danger: true });
  if (r) await op('node.remove', { wsId, nodeId: node.id });
}

const resizeEnd = (wsId: string, id: string) => (_: unknown, p: { x: number; y: number; width: number; height: number }) =>
  op('node.update', { wsId, nodeId: id, patch: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) } });

// ------------------------------------------------------------------ terminal
export const TerminalNode = memo(({ data, selected }: NodeProps) => {
  const { node, wsId } = data as NodeDataIn<TerminalData>;
  const d = node.data;
  const status = useStore((s) => s.statuses[node.id]);
  const roles = useStore((s) => s.config?.roles);
  const wsRoles = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.roles);
  const role = [...(wsRoles ?? []), ...(roles ?? [])].find((r) => r.id === d.roleId);
  return (
    <div className={`card terminal ${selected ? 'sel' : ''} st-${status ?? 'exited'}`} style={{ ['--accent' as string]: d.color }}>
      <NodeResizer isVisible={selected} minWidth={360} minHeight={200} onResizeEnd={resizeEnd(wsId, node.id)} />
      <Ports />
      <header className="drag-handle" onDoubleClick={() => rename(wsId, node as never)}>
        <StatusDot status={status} />
        <span className="ico">{d.icon || (d.agentType === 'shell' ? '›_' : '✦')}</span>
        <b className="title">{d.name}</b>
        {d.maestro && <span className="tag">maestro</span>}
        {role && <span className="tag" title={role.prompt}>{role.name}</span>}
        <span className="muted small">{STATUS_LABEL[status ?? 'exited']}</span>
        <span className="spacer" />
        <Icon title={d.chat ? 'Ver terminal' : 'Ver chat'} onClick={() => update(wsId, node.id, { chat: !d.chat })}>{d.chat ? '⌨' : '💬'}</Icon>
        <Icon title="Interromper (Ctrl-C)" onClick={() => op('node.interrupt', { nodeId: node.id })}>⏹</Icon>
        <Icon title="Reiniciar processo" onClick={() => op('node.restart', { nodeId: node.id })}>↻</Icon>
        <Icon title="Configurar" onClick={() => configureTerminal(wsId, node)}>⚙</Icon>
        <Icon title="Remover" onClick={() => remove(wsId, node, 'terminal')}>✕</Icon>
      </header>
      <div className="body">{d.chat ? <ChatView id={node.id} name={d.name} /> : <XTerm id={node.id} />}</div>
    </div>
  );
});

async function configureTerminal(wsId: string, node: PalcoNode<TerminalData>) {
  const s = getState();
  const ws = s.workspaces.find((w) => w.id === wsId);
  const roles = [...(ws?.roles ?? []), ...(s.config?.roles ?? [])];
  const d = node.data;
  const r = await dialog(`Configurar ${d.name}`, [
    { key: 'name', label: 'Nome', value: d.name },
    { key: 'command', label: 'Comando', value: d.command, placeholder: 'vazio = shell', hint: 'Mudar comando, pasta ou role reinicia o processo.' },
    { key: 'cwd', label: 'Pasta', value: d.cwd },
    { key: 'roleId', label: 'Role', type: 'select', value: d.roleId ?? '', options: [{ value: '', label: '(nenhuma)' }, ...roles.map((x) => ({ value: x.id, label: x.name }))] },
    { key: 'color', label: 'Cor', value: d.color },
    { key: 'icon', label: 'Ícone (emoji)', value: d.icon ?? '' },
    { key: 'maestro', label: 'Maestro (coordena a equipe)', type: 'checkbox', value: String(!!d.maestro) },
  ], { submit: 'Salvar' });
  if (!r) return;
  const restart = r.command !== d.command || r.cwd !== d.cwd || (r.roleId || undefined) !== d.roleId;
  await update(wsId, node.id, { name: r.name, command: r.command, cwd: r.cwd, roleId: r.roleId || undefined, color: r.color, icon: r.icon || undefined, maestro: r.maestro === 'true' });
  if (restart) await op('node.restart', { nodeId: node.id });
}

// ---------------------------------------------------------------------- note
export const NoteNode = memo(({ data, selected }: NodeProps) => {
  const { node, wsId } = data as NodeDataIn<NoteData>;
  const d = node.data;
  const remote = useStore((s) => s.notes[node.id]);
  const [text, setText] = useState(remote ?? '');
  const [editing, setEditing] = useState(!d.preview);
  const focused = useRef(false);
  useEffect(() => {
    if (remote === undefined) op<string>('note.read', { wsId, nodeId: node.id }).then((c) => setState((s) => ({ notes: { ...s.notes, [node.id]: c } }))).catch(() => {});
  }, [wsId, node.id, remote]);
  useEffect(() => { if (!focused.current && remote !== undefined) setText(remote); }, [remote]);
  const save = useDebounced((v: string) => op('note.write', { wsId, nodeId: node.id, content: v }), 400);
  const bg = noteColor(d.color);
  return (
    <div className={`card note ${selected ? 'sel' : ''}`} style={{ ['--note' as string]: bg }}>
      <NodeResizer isVisible={selected} minWidth={180} minHeight={120} onResizeEnd={resizeEnd(wsId, node.id)} />
      <Ports />
      <header className="drag-handle" onDoubleClick={() => rename(wsId, node as never)}>
        <b className="title">{d.name}</b>
        {d.stack && <span className="tag">🗂 {d.stack}</span>}
        <span className="spacer" />
        <select className="mini nodrag" value={d.color} title="Cor" onChange={(e) => update(wsId, node.id, { color: e.target.value })}>
          {Object.keys(NOTE_COLORS).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Icon title={d.locked ? 'Destrancar (agentes podem editar)' : 'Trancar (agentes só leem)'} onClick={() => update(wsId, node.id, { locked: !d.locked })}>{d.locked ? '🔒' : '🔓'}</Icon>
        <Icon title={editing ? 'Visualizar' : 'Editar'} onClick={() => { setEditing(!editing); update(wsId, node.id, { preview: editing }); }}>{editing ? '👁' : '✎'}</Icon>
        <Icon title="Remover" onClick={() => remove(wsId, node, 'nota')}>✕</Icon>
      </header>
      <div className="body nodrag nowheel">
        {editing ? (
          <textarea
            value={text}
            placeholder="Markdown…"
            onFocus={() => { focused.current = true; }}
            onBlur={() => { focused.current = false; }}
            onChange={(e) => { setText(e.target.value); save(e.target.value); }}
          />
        ) : (
          <div className="note-preview" onDoubleClick={() => setEditing(true)}>
            {text.trim() ? <Markdown src={text} /> : <span className="muted">Nota vazia — clique duas vezes para escrever.</span>}
          </div>
        )}
      </div>
    </div>
  );
});

// -------------------------------------------------------------------- portal
export const PortalNode = memo(({ data, selected }: NodeProps) => {
  const { node, wsId } = data as NodeDataIn<PortalData>;
  const d = node.data;
  const img = useRef<HTMLImageElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(d.url);
  const [err, setErr] = useState('');
  const [hasFrame, setHasFrame] = useState(false);
  useEffect(() => setUrl(d.url), [d.url]);

  useEffect(() => {
    const off = onMessage((m) => {
      if (m.id !== node.id) return;
      if (m.t === 'frame' && img.current) { img.current.src = `data:image/jpeg;base64,${m.data}`; setHasFrame(true); setErr(''); }
      if (m.t === 'portal-error') setErr(m.error);
    });
    const offOpen = onMessage((m) => { if (m.t === 'open') send({ t: 'watch', id: node.id }); });
    send({ t: 'watch', id: node.id });
    return () => { off(); offOpen(); send({ t: 'unwatch', id: node.id }); };
  }, [node.id]);

  // keep the remote viewport equal to the on-screen size so pixels map 1:1
  const pushViewport = useDebounced((w: number, h: number) => send({ t: 'portal-viewport', id: node.id, width: w, height: h }), 500);
  useEffect(() => {
    const el = body.current!;
    const ro = new ResizeObserver(() => {
      if (d.ua && d.ua !== 'desktop') return;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w > 50 && h > 50 && (Math.abs(w - d.viewport.width) > 2 || Math.abs(h - d.viewport.height) > 2)) pushViewport(w, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [node.id, d.ua, d.viewport.width, d.viewport.height]);

  const pt = (e: React.MouseEvent | React.WheelEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * d.viewport.width, y: ((e.clientY - r.top) / r.height) * d.viewport.height };
  };
  const input = (ev: Record<string, unknown>) => send({ t: 'portal-input', id: node.id, ev });
  const lastMove = useRef(0);
  const btn = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  return (
    <div className={`card portal ${selected ? 'sel' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={320} minHeight={240} onResizeEnd={resizeEnd(wsId, node.id)} />
      <Ports />
      <header className="drag-handle" onDoubleClick={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') void rename(wsId, node as never); }}>
        <span className="ico">🌐</span>
        <b className="title">{d.name}</b>
        <Icon title="Voltar" onClick={() => input({ kind: 'back' })}>←</Icon>
        <Icon title="Avançar" onClick={() => input({ kind: 'forward' })}>→</Icon>
        <Icon title="Recarregar" onClick={() => input({ kind: 'reload' })}>↻</Icon>
        <form className="urlbar nodrag" onSubmit={(e) => { e.preventDefault(); input({ kind: 'navigate', url }); }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="endereço ou localhost:3000" spellCheck={false} />
        </form>
        <select className="mini nodrag" value={d.ua ?? 'desktop'} title="Dispositivo" onChange={(e) => void fetchUa(node.id, e.target.value)}>
          <option value="desktop">desktop</option><option value="ios">iPhone</option><option value="android">Android</option>
        </select>
        <Icon title="Remover" onClick={() => remove(wsId, node, 'portal')}>✕</Icon>
      </header>
      <div
        className="body portal-view nodrag nowheel nopan"
        ref={body}
        tabIndex={0}
        onMouseDown={(e) => { e.currentTarget.focus(); if (img.current) input({ kind: 'down', ...pt(e), button: btn(e.button) }); }}
        onMouseUp={(e) => img.current && input({ kind: 'up', ...pt(e), button: btn(e.button) })}
        onMouseMove={(e) => { const t = performance.now(); if (img.current && t - lastMove.current > 40) { lastMove.current = t; input({ kind: 'move', ...pt(e) }); } }}
        onWheel={(e) => img.current && input({ kind: 'wheel', ...pt(e), dx: e.deltaX, dy: e.deltaY })}
        onContextMenu={(e) => e.preventDefault()}
        onPaste={(e) => { e.preventDefault(); input({ kind: 'text', text: e.clipboardData.getData('text') }); }}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // keys belong to the page: never let React Flow see Backspace/Delete and remove this card
          e.stopPropagation();
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return; // let paste event fire
          e.preventDefault();
          const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
          input({ kind: 'key', key: e.key === ' ' ? ' ' : e.key, mods });
        }}
      >
        <img ref={img} alt="" draggable={false} style={{ aspectRatio: `${d.viewport.width} / ${d.viewport.height}`, opacity: hasFrame ? 1 : 0 }} />
        {!hasFrame && <div className="portal-wait">{err ? `Erro: ${err}` : d.url ? 'Abrindo navegador…' : 'Digite um endereço acima.'}</div>}
      </div>
    </div>
  );
});

async function fetchUa(nodeId: string, ua: string) {
  const r = await cli(['portal', 'ua', nameOfNode(nodeId), ua]);
  if (r.code) toast(r.out, 'Portal');
}

function nameOfNode(id: string) {
  for (const w of getState().workspaces) {
    const n = w.nodes.find((x) => x.id === id);
    if (n) return `${(n.data as { name: string }).name} @ ${w.name}`;
  }
  return '';
}

// ---------------------------------------------------------------------- band
export const BandNode = memo(({ data, selected }: NodeProps) => {
  const { node, wsId } = data as NodeDataIn<BandData>;
  const d = node.data;
  const ws = useStore((s) => s.workspaces.find((w) => w.id === wsId));
  const statuses = useStore((s) => s.statuses);
  const rf = useReactFlow();
  const members = useMemo(() => d.members.map((id) => ws?.nodes.find((n) => n.id === id)).filter(Boolean) as PalcoNode<TerminalData>[], [d.members, ws]);
  const addSelected = () => {
    const sel = rf.getNodes().filter((n) => n.selected && n.type === 'terminal' && !d.members.includes(n.id)).map((n) => n.id);
    if (!sel.length) return toast('Selecione terminais no canvas (Shift+clique) e clique de novo.', 'Band');
    void op('band.setMembers', { wsId, bandId: node.id, members: [...d.members, ...sel] }).catch((e) => toast((e as Error).message));
  };
  const busy = members.filter((m) => statuses[m.id] === 'busy').length;
  return (
    <div className={`card band ${selected ? 'sel' : ''}`} style={{ ['--accent' as string]: d.color }}>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} onResizeEnd={resizeEnd(wsId, node.id)} />
      <Ports />
      <header className="drag-handle" onDoubleClick={() => rename(wsId, node as never)}>
        <span className="ico">{d.icon || '🎼'}</span>
        <b className="title">{d.name}</b>
        <span className="muted small">{busy}/{members.length} trabalhando</span>
        <span className="spacer" />
        <Icon title="Adicionar terminais selecionados" onClick={addSelected}>＋</Icon>
        <Icon title="Dissolver band" onClick={() => remove(wsId, node, 'band')}>✕</Icon>
      </header>
      <ul className="body band-list nodrag nowheel">
        {[...members].sort((a, b) => Number(!!b.data.maestro) - Number(!!a.data.maestro)).map((m) => (
          <li key={m.id} onClick={() => setState({ focusNode: { id: m.id, at: Date.now() } })}>
            <StatusDot status={statuses[m.id]} />
            <span>{m.data.maestro ? '★ ' : ''}{m.data.name}</span>
            <span className="muted small">{STATUS_LABEL[statuses[m.id] ?? 'exited']}</span>
            <b className="x" title="Tirar da band" onClick={(e) => { e.stopPropagation(); void op('band.setMembers', { wsId, bandId: node.id, members: d.members.filter((x) => x !== m.id) }); }}>×</b>
          </li>
        ))}
      </ul>
    </div>
  );
});

// ------------------------------------------------------------------- drawing
export const DrawingNode = memo(({ data, selected }: NodeProps) => {
  const { node } = data as NodeDataIn<DrawingData>;
  const d = node.data;
  const pts = d.points;
  let shape: React.ReactNode = null;
  if (d.kind === 'rect' && pts.length >= 2) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    shape = <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} rx={8} />;
  } else if (d.kind === 'arrow' && pts.length >= 2) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h = 14 + d.width * 2;
    const p1 = [b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45)];
    const p2 = [b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45)];
    shape = <><line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} /><polyline points={`${p1.join(',')} ${b.join(',')} ${p2.join(',')}`} /></>;
  } else {
    shape = <polyline points={pts.map((p) => p.join(',')).join(' ')} />;
  }
  return (
    <svg className={`drawing ${selected ? 'sel' : ''}`} width={node.w} height={node.h} style={{ overflow: 'visible' }}>
      <g fill="none" stroke={d.color} strokeWidth={d.width} strokeLinecap="round" strokeLinejoin="round">{shape}</g>
    </svg>
  );
});

export const nodeTypes = { terminal: TerminalNode, note: NoteNode, portal: PortalNode, band: BandNode, drawing: DrawingNode };
