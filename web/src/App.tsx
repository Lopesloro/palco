import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { op, token } from './api';
import { currentFloorId, currentWorkspace, getState, setState, toast, useStore, type State } from './store';
import { Canvas } from './Canvas';
import { Composer } from './Composer';
import { Panel } from './Panels';
import { DialogHost, Icon, StatusDot, STATUS_LABEL, dialog } from './ui';
import type { Floor, PalcoNode, TerminalData, Workspace } from './types';

const err = (e: unknown) => toast((e as Error).message);

async function newWorkspace() {
  const home = getState().home;
  const r = await dialog('Novo workspace', [
    { key: 'name', label: 'Nome', placeholder: 'Meu projeto' },
    { key: 'dir', label: 'Pasta do projeto', value: home, hint: 'Os terminais começam aqui. Andares com git usam esta pasta.' },
  ], { submit: 'Criar' });
  if (!r?.name) return;
  const ws = await op<Workspace>('ws.create', { name: r.name, dir: r.dir || home }).catch(err);
  if (ws) setState({ currentWs: ws.id });
}

async function workspaceMenu(ws: Workspace) {
  const r = await dialog(`Workspace ${ws.name}`, [
    { key: 'name', label: 'Nome', value: ws.name },
    { key: 'dir', label: 'Pasta', value: ws.dir },
    { key: 'delete', label: 'Apagar este workspace (encerra os terminais; não toca nos arquivos do projeto)', type: 'checkbox', value: 'false' },
  ], { submit: 'Aplicar' });
  if (!r) return;
  if (r.delete === 'true') {
    if (await dialog(`Apagar "${ws.name}" de vez?`, [], { submit: 'Apagar', danger: true })) await op('ws.delete', { wsId: ws.id }).catch(err);
    return;
  }
  if (r.name !== ws.name) await op('ws.rename', { wsId: ws.id, name: r.name }).catch(err);
  if (r.dir !== ws.dir) await op('ws.setDir', { wsId: ws.id, dir: r.dir }).catch(err);
}

function Sidebar({ ws, floorId }: { ws?: Workspace; floorId?: string }) {
  const workspaces = useStore((s) => s.workspaces);
  const statuses = useStore((s) => s.statuses);
  const connected = useStore((s) => s.connected);
  const version = useStore((s) => s.version);
  const panel = useStore((s) => s.panel);
  const agents = useMemo(() => (ws?.nodes.filter((n) => n.type === 'terminal') ?? []) as PalcoNode<TerminalData>[], [ws]);
  const needs = (id: string) => statuses[id] === 'idle';
  const toggle = (p: State['panel']) => setState({ panel: panel === p ? undefined : p });
  return (
    <nav className="sidebar">
      <div className="brand"><span className="logo">◐</span> Palco <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'conectado' : 'reconectando…'} /></div>
      <h5>Workspaces</h5>
      <ul className="ws-list">
        {workspaces.map((w, i) => {
          const terms = w.nodes.filter((n) => n.type === 'terminal');
          const busy = terms.filter((n) => statuses[n.id] === 'busy').length;
          return (
            <li key={w.id} className={w.id === ws?.id ? 'on' : ''} onClick={() => { setState({ currentWs: w.id }); void op('ws.open', { wsId: w.id }); }} onDoubleClick={() => void workspaceMenu(w)} title={`${w.dir}\n⌘${i + 1} · duplo clique para editar`}>
              <span className="name">{w.name}</span>
              <span className="muted small">{busy ? `${busy}⚡ ` : ''}{terms.length}</span>
            </li>
          );
        })}
      </ul>
      <button className="ghost add" onClick={() => void newWorkspace()}>＋ Workspace</button>

      {ws && (
        <>
          <h5>Agentes</h5>
          <ul className="agent-list">
            {agents.map((a) => {
              const floor = ws.floors.find((f) => f.id === a.floorId);
              return (
                <li key={a.id} onClick={() => setState({ focusNode: { id: a.id, at: Date.now() } })} className={a.floorId === floorId ? '' : 'other-floor'}>
                  <StatusDot status={statuses[a.id]} />
                  <span className="name">{a.data.maestro ? '★ ' : ''}{a.data.name}</span>
                  <span className="muted small">{floor && !floor.ground ? `${floor.name} · ` : ''}{needs(a.id) ? 'esperando' : STATUS_LABEL[statuses[a.id] ?? 'exited']}</span>
                </li>
              );
            })}
            {!agents.length && <li className="muted small">Nenhum agente ainda.</li>}
          </ul>
        </>
      )}

      <div className="side-foot">
        {(['routines', 'roles', 'presets', 'partituras', 'settings', 'help'] as const).map((p) => (
          <button key={p} className={`ghost ${panel === p ? 'active' : ''}`} onClick={() => toggle(p)}>
            {{ routines: '⏰ Routines', roles: '🎭 Roles', presets: '🧩 Presets', partituras: '🎼 Partituras', settings: '⚙ Configurações', help: '? Ajuda' }[p]}
          </button>
        ))}
        <div className="muted small ver">v{version}</div>
      </div>
    </nav>
  );
}

async function newFloor(ws: Workspace) {
  const r = await dialog('Novo andar (cópia isolada do workspace)', [
    { key: 'name', label: 'Nome', placeholder: 'Experimento' },
    { key: 'branch', label: 'Branch (se for repositório git)', placeholder: 'palco/experimento' },
    { key: 'copy', label: 'Clonar node_modules e arquivos não rastreados (copy-on-write)', type: 'checkbox', value: 'false' },
    { key: 'noGit', label: 'Sem git: cópia simples da pasta', type: 'checkbox', value: 'false' },
  ], { submit: 'Criar andar' });
  if (!r?.name) return;
  try {
    const res = await op<{ floor: Floor; note: string }>('floor.create', { wsId: ws.id, name: r.name, opts: { branch: r.branch || undefined, copy: r.copy === 'true', noGit: r.noGit === 'true' } });
    setState((s) => ({ currentFloor: { ...s.currentFloor, [ws.id]: res.floor.id } }));
    toast(res.note, `Andar ${res.floor.name}`);
  } catch (e) { err(e); }
}

async function floorMenu(ws: Workspace, f: Floor) {
  if (f.ground) return toast('O térreo é a pasta principal do workspace.');
  const r = await dialog(`Andar ${f.name}`, [
    { key: 'action', label: 'Ação', type: 'select', value: 'land', options: [
      { value: 'land', label: f.git ? `Integrar (merge de ${f.branch} e apagar o andar)` : 'Integrar (só para andares git)' },
      { value: 'land-keep', label: 'Integrar e manter o andar' },
      { value: 'unload', label: f.unloaded ? 'Recarregar agentes' : 'Descarregar (para os agentes)' },
      { value: 'rename', label: 'Renomear' },
      { value: 'delete', label: 'Apagar andar (descarta mudanças não integradas)' },
    ] },
    { key: 'name', label: 'Novo nome (para renomear)', value: f.name },
  ], { submit: 'Executar' });
  if (!r) return;
  try {
    if (r.action === 'land' || r.action === 'land-keep') toast(await op<string>('floor.land', { wsId: ws.id, name: f.name, opts: { keepFloor: r.action === 'land-keep', deleteBranch: r.action === 'land' } }), 'Land');
    else if (r.action === 'unload') { if (f.unloaded) await op('floor.load', { wsId: ws.id, floorId: f.id }); else await op('floor.unload', { wsId: ws.id, name: f.name }); }
    else if (r.action === 'rename') await op('floor.rename', { wsId: ws.id, floorId: f.id, name: r.name });
    else if (r.action === 'delete' && await dialog(`Apagar o andar ${f.name}? Mudanças não integradas são perdidas.`, [], { submit: 'Apagar', danger: true })) {
      toast(await op<string>('floor.remove', { wsId: ws.id, name: f.name, opts: { force: true } }));
      setState((s) => ({ currentFloor: { ...s.currentFloor, [ws.id]: ws.floors.find((x) => x.ground)!.id } }));
    }
  } catch (e) { err(e); }
}

function TopBar({ ws, floorId }: { ws: Workspace; floorId: string }) {
  const presets = useStore((s) => s.config?.presets);
  const tool = useStore((s) => s.tool);
  const add = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      if (type === 'portal') {
        const r = await dialog('Novo portal', [{ key: 'url', label: 'Endereço', placeholder: 'localhost:3000' }, { key: 'name', label: 'Nome', value: 'Portal' }]);
        if (!r) return;
        extra = { data: { name: r.name || 'Portal', url: r.url } };
      }
      const n = await op<PalcoNode>('node.add', { wsId: ws.id, type, floorId, ...extra });
      setState({ focusNode: { id: n.id, at: Date.now() } });
    } catch (e) { err(e); }
  };
  return (
    <div className="topbar">
      <div className="floors">
        {ws.floors.map((f) => (
          <button key={f.id} className={`floor ${f.id === floorId ? 'on' : ''} ${f.unloaded ? 'unloaded' : ''}`}
            onClick={() => setState((s) => ({ currentFloor: { ...s.currentFloor, [ws.id]: f.id } }))}
            onDoubleClick={() => void floorMenu(ws, f)}
            title={`${f.dir}${f.branch ? `\nbranch ${f.branch}` : ''}\nduplo clique: integrar, renomear, apagar`}>
            {f.ground ? '⌂ Térreo' : f.name}
            {f.status && <span className={`fstate s-${f.status.state ?? 'working'}`} title={f.status.text}>{f.status.progress ?? f.status.state ?? '•'}</span>}
          </button>
        ))}
        <button className="ghost" title="Novo andar" onClick={() => void newFloor(ws)}>＋ andar</button>
      </div>
      <span className="spacer" />
      <div className="quick">
        {(presets ?? []).filter((p) => p.quickStart).map((p) => (
          <button key={p.id} className="ghost" onClick={() => void add('terminal', { presetId: p.id })} title={p.command || 'shell'}>
            <span className="swatch" style={{ background: p.color }} /> {p.name}
          </button>
        ))}
        <button className="ghost" onClick={() => void add('note')}>📝 Nota</button>
        <button className="ghost" onClick={() => void add('portal')}>🌐 Portal</button>
      </div>
      <div className="tools">
        <Icon title="Selecionar (Esc)" active={tool === 'select'} onClick={() => setState({ tool: 'select' })}>➤</Icon>
        <Icon title="Caneta" active={tool === 'pen'} onClick={() => setState({ tool: 'pen' })}>✎</Icon>
        <Icon title="Seta" active={tool === 'arrow'} onClick={() => setState({ tool: 'arrow' })}>↗</Icon>
        <Icon title="Retângulo" active={tool === 'rect'} onClick={() => setState({ tool: 'rect' })}>▭</Icon>
      </div>
      {ws.floors.find((f) => f.id === floorId)?.status?.text && (
        <div className="floor-status muted small">{ws.floors.find((f) => f.id === floorId)!.status!.text}</div>
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className="toast"><b>{t.title}</b><div>{t.text}</div></div>)}
    </div>
  );
}

function useShortcuts(ws?: Workspace, floorId?: string) {
  useEffect(() => {
    const h = async (e: KeyboardEvent) => {
      const s = getState();
      if (!(e.metaKey || e.ctrlKey)) return;
      if (/^[1-9]$/.test(e.key) && !e.altKey) {
        const w = s.workspaces[Number(e.key) - 1];
        if (w) { e.preventDefault(); setState({ currentWs: w.id }); }
        return;
      }
      if (!ws || !floorId || !e.altKey) return;
      const k = e.code;
      if (k === 'KeyT') { e.preventDefault(); const p = s.config?.presets.find((x) => x.quickStart); await op('node.add', { wsId: ws.id, type: 'terminal', floorId, presetId: p?.id }).catch(err); }
      if (k === 'KeyN') { e.preventDefault(); await op('node.add', { wsId: ws.id, type: 'note', floorId }).catch(err); }
      if (k === 'KeyL') {
        e.preventDefault();
        if (s.selection.length !== 2) return toast('Selecione exatamente dois cards (Shift+clique).');
        await op('edge.add', { wsId: ws.id, a: s.selection[0], b: s.selection[1] }).catch(err);
      }
      if (k === 'KeyB') {
        e.preventDefault();
        const members = s.selection.filter((id) => ws.nodes.find((n) => n.id === id)?.type === 'terminal');
        const r = await dialog('Nova band', [{ key: 'name', label: 'Nome', value: 'Band' }]);
        if (r) await op('band.create', { wsId: ws.id, name: r.name, members }).catch(err);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [ws?.id, floorId]);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const ws = useStore(currentWorkspace);
  const floorMap = useStore((s) => s.currentFloor);
  const floorId = useMemo(() => currentFloorId({ ...getState(), currentFloor: floorMap }, ws), [ws, floorMap]);
  useShortcuts(ws, floorId);

  if (!token) {
    return (
      <div className="splash">
        <h1>◐ Palco</h1>
        <p>Abra pelo terminal para entrar com seu token local:</p>
        <pre>palco</pre>
      </div>
    );
  }
  if (!ready) return <div className="splash"><h1>◐ Palco</h1><p className="muted">Conectando ao serviço local…</p></div>;
  return (
    <div className="app">
      <Sidebar ws={ws} floorId={floorId} />
      <main>
        {ws && floorId && (
          <>
            <TopBar ws={ws} floorId={floorId} />
            <ReactFlowProvider key={`${ws.id}:${floorId}`}>
              <Canvas ws={ws} floorId={floorId} />
            </ReactFlowProvider>
            <Composer ws={ws} />
            <Panel ws={ws} floorId={floorId} />
          </>
        )}
      </main>
      <Toasts />
      <DialogHost />
    </div>
  );
}
