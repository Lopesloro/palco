import { useEffect, useState } from 'react';
import { cli, op } from './api';
import { getState, setState, toast, useStore } from './store';
import { dialog } from './ui';
import type { Preset, Role, Routine, Workspace } from './types';

const err = (e: unknown) => toast((e as Error).message);
const EMPTY: never[] = [];

export function Panel({ ws, floorId }: { ws: Workspace; floorId: string }) {
  const panel = useStore((s) => s.panel);
  if (!panel) return null;
  const title = { routines: 'Routines', roles: 'Roles', presets: 'Presets de agentes', partituras: 'Partituras', settings: 'Configurações', help: 'Ajuda' }[panel];
  return (
    <aside className="panel">
      <header>
        <h3>{title}</h3>
        <span className="spacer" />
        <button className="ghost" onClick={() => setState({ panel: undefined })}>✕</button>
      </header>
      <div className="panel-body">
        {panel === 'routines' && <Routines ws={ws} />}
        {panel === 'roles' && <Roles ws={ws} />}
        {panel === 'presets' && <Presets />}
        {panel === 'partituras' && <Partituras ws={ws} floorId={floorId} />}
        {panel === 'settings' && <Settings />}
        {panel === 'help' && <Help />}
      </div>
    </aside>
  );
}

const SCHEDULES = [
  { value: 'every', label: 'A cada (ex.: 10m, 2h)' },
  { value: 'at', label: 'Todo dia às (HH:MM)' },
  { value: 'cron', label: 'Cron (ex.: */15 9-18 * * 1-5)' },
  { value: 'once', label: 'Uma vez (2026-12-01T09:00)' },
];

function describe(r: Routine) {
  const s = r.schedule;
  return s.every ? `a cada ${s.every}` : s.at ? `todo dia às ${s.at}` : s.cron ? `cron ${s.cron}` : s.once ? `em ${new Date(s.once).toLocaleString()}` : '';
}

function Routines({ ws }: { ws: Workspace }) {
  const [next, setNext] = useState<Record<string, string | undefined>>({});
  useEffect(() => { op<Record<string, string>>('routine.next', { wsId: ws.id }).then(setNext).catch(() => {}); }, [ws]);
  const terminals = ws.nodes.filter((n) => n.type === 'terminal').map((n) => (n.data as { name: string }).name);

  const edit = async (r?: Routine) => {
    const kind = r?.schedule.every ? 'every' : r?.schedule.at ? 'at' : r?.schedule.cron ? 'cron' : r?.schedule.once ? 'once' : 'every';
    const v = await dialog(r ? `Editar ${r.name}` : 'Nova routine', [
      { key: 'name', label: 'Nome', value: r?.name ?? '' },
      { key: 'kind', label: 'Tipo', type: 'select', value: r?.kind ?? 'prompt', options: [
        { value: 'prompt', label: 'Prompt para um agente' }, { value: 'command', label: 'Comando no terminal' }, { value: 'reminder', label: 'Lembrete (notificação)' }] },
      { key: 'target', label: 'Terminal alvo', type: 'select', value: r?.target ?? terminals[0] ?? '', options: [{ value: '', label: '(nenhum — lembrete)' }, ...terminals.map((t) => ({ value: t, label: t }))] },
      { key: 'command', label: 'Texto / comando', type: 'textarea', value: r?.command ?? '' },
      { key: 'sched', label: 'Agenda', type: 'select', value: kind, options: SCHEDULES },
      { key: 'when', label: 'Valor da agenda', value: r ? (r.schedule.every ?? r.schedule.at ?? r.schedule.cron ?? r.schedule.once ?? '') : '1h' },
      { key: 'skipIfBusy', label: 'Pular se o agente estiver ocupado', type: 'checkbox', value: String(r?.skipIfBusy ?? true) },
    ], { submit: 'Salvar' });
    if (!v) return;
    const routine = {
      name: v.name, kind: v.kind as Routine['kind'], target: v.target || undefined, command: v.command,
      schedule: { [v.sched]: v.when.trim() }, enabled: r?.enabled ?? true, skipIfBusy: v.skipIfBusy === 'true',
    };
    try {
      if (r) await op('routine.update', { wsId: ws.id, name: r.name, patch: routine });
      else await op('routine.create', { wsId: ws.id, routine });
    } catch (e) { err(e); }
  };

  return (
    <>
      <p className="muted">Comandos e prompts agendados para os agentes deste workspace. Também pela CLI: <code>palco routine create</code>.</p>
      <button className="primary" onClick={() => void edit()}>＋ Nova routine</button>
      <ul className="list">
        {ws.routines.map((r) => (
          <li key={r.id}>
            <div className="row">
              <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => op('routine.update', { wsId: ws.id, name: r.name, patch: { enabled: e.target.checked } }).catch(err)} /></label>
              <b>{r.name}</b><span className="tag">{r.kind}</span>
              <span className="spacer" />
              <button className="ghost" onClick={() => op<string>('routine.run', { wsId: ws.id, name: r.name }).then((x) => toast(x, r.name)).catch(err)}>▶</button>
              <button className="ghost" onClick={() => void edit(r)}>✎</button>
              <button className="ghost" onClick={async () => { if (await dialog(`Apagar a routine ${r.name}?`, [], { submit: 'Apagar', danger: true })) op('routine.remove', { wsId: ws.id, name: r.name }).catch(err); }}>✕</button>
            </div>
            <div className="muted small">{r.target ? `→ ${r.target} · ` : ''}{describe(r)}{next[r.id] ? ` · próxima ${new Date(next[r.id]!).toLocaleString()}` : ''}</div>
            <pre className="small">{r.command}</pre>
            {r.lastRunAt && <div className="muted small">última: {new Date(r.lastRunAt).toLocaleString()} — {r.lastResult}</div>}
          </li>
        ))}
        {!ws.routines.length && <li className="muted">Nenhuma routine.</li>}
      </ul>
    </>
  );
}

function Roles({ ws }: { ws: Workspace }) {
  const global = useStore((s) => s.config?.roles ?? EMPTY);
  const edit = async (r?: Role) => {
    const v = await dialog(r ? `Editar role ${r.name}` : 'Nova role', [
      { key: 'name', label: 'Nome', value: r?.name ?? '' },
      { key: 'prompt', label: 'Instruções', type: 'textarea', value: r?.prompt ?? '', hint: 'Dica: peça para rodar `palco list` antes de falar com colegas.' },
      { key: 'scope', label: 'Escopo', type: 'select', value: r?.scope ?? 'workspace', options: [{ value: 'workspace', label: `Só ${ws.name}` }, { value: 'global', label: 'Global' }] },
    ], { submit: 'Salvar' });
    if (!v?.name) return;
    await op('role.save', { wsId: ws.id, role: { id: r?.id ?? '', name: v.name, prompt: v.prompt, scope: v.scope } }).catch(err);
  };
  const row = (r: Role) => (
    <li key={r.id}>
      <div className="row"><b>{r.name}</b><span className="tag">{r.scope === 'global' ? 'global' : 'workspace'}</span><span className="spacer" />
        <button className="ghost" onClick={() => void edit(r)}>✎</button>
        <button className="ghost" onClick={async () => { if (await dialog(`Apagar a role ${r.name}?`, [], { submit: 'Apagar', danger: true })) op('role.remove', { id: r.id }).catch(err); }}>✕</button>
      </div>
      <div className="muted small clamp">{r.prompt}</div>
    </li>
  );
  return (
    <>
      <p className="muted">Instruções reutilizáveis. Atribua no ⚙ do terminal; no Claude Code vira system prompt, nos outros agentes é o primeiro prompt.</p>
      <button className="primary" onClick={() => void edit()}>＋ Nova role</button>
      <h4>{ws.name}</h4>
      <ul className="list">{ws.roles.map(row)}{!ws.roles.length && <li className="muted">Nenhuma.</li>}</ul>
      <h4>Globais</h4>
      <ul className="list">{global.map(row)}{!global.length && <li className="muted">Nenhuma.</li>}</ul>
    </>
  );
}

function Presets() {
  const presets = useStore((s) => s.config?.presets ?? EMPTY);
  const edit = async (p?: Preset) => {
    const v = await dialog(p ? `Editar ${p.name}` : 'Novo preset', [
      { key: 'name', label: 'Nome', value: p?.name ?? '' },
      { key: 'command', label: 'Comando', value: p?.command ?? '', placeholder: 'claude --model opus', hint: 'Vazio = shell. Variáveis de ambiente na frente funcionam: FOO=1 claude' },
      { key: 'color', label: 'Cor', value: p?.color ?? '#4f9dde' },
      { key: 'chat', label: 'Começa no modo chat', type: 'checkbox', value: String(!!p?.chat) },
      { key: 'maestro', label: 'Maestro (coordenador)', type: 'checkbox', value: String(!!p?.maestro) },
      { key: 'quickStart', label: 'Aparece no menu rápido', type: 'checkbox', value: String(p?.quickStart ?? true) },
    ], { submit: 'Salvar' });
    if (!v?.name) return;
    const prog = v.command.trim().split(/\s+/).find((t) => !t.includes('='))?.split('/').pop() ?? '';
    const agentType = ({ claude: 'claude_code', codex: 'codex', opencode: 'opencode', gemini: 'gemini', '': 'shell' } as Record<string, Preset['agentType']>)[prog] ?? 'custom';
    await op('preset.save', { preset: { ...(p ?? {}), id: p?.id ?? '', name: v.name, command: v.command, color: v.color, chat: v.chat === 'true', maestro: v.maestro === 'true', quickStart: v.quickStart === 'true', agentType } }).catch(err);
  };
  return (
    <>
      <button className="primary" onClick={() => void edit()}>＋ Novo preset</button>
      <ul className="list">
        {presets.map((p) => (
          <li key={p.id}>
            <div className="row"><span className="swatch" style={{ background: p.color }} /><b>{p.name}</b><span className="tag">{p.agentType}</span><span className="spacer" />
              <button className="ghost" onClick={() => void edit(p)}>✎</button>
              <button className="ghost" onClick={async () => { if (await dialog(`Apagar o preset ${p.name}?`, [], { submit: 'Apagar', danger: true })) op('preset.remove', { id: p.id }).catch(err); }}>✕</button>
            </div>
            <code className="small">{p.command || '(shell)'}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

function Partituras({ ws, floorId }: { ws: Workspace; floorId: string }) {
  const parts = useStore((s) => s.config?.partituras ?? EMPTY);
  return (
    <>
      <p className="muted">Equipes salvas (agentes, roles, notas e cordas). Um agente salva a própria equipe com <code>palco partitura create "Nome"</code>.</p>
      <ul className="list">
        {parts.map((p) => (
          <li key={p.id}>
            <div className="row"><b>{p.name}</b><span className="muted small">{p.items.filter((i) => i.type === 'terminal').length} agentes · {p.items.filter((i) => i.type === 'note').length} notas</span><span className="spacer" />
              <button className="ghost" title="Colocar neste andar" onClick={() => op<string>('partitura.insert', { wsId: ws.id, floorId, name: p.name }).then((x) => toast(x)).catch(err)}>⤓</button>
              <button className="ghost" onClick={async () => { if (await dialog(`Apagar a partitura ${p.name}?`, [], { submit: 'Apagar', danger: true })) op('partitura.delete', { id: p.id }).catch(err); }}>✕</button>
            </div>
          </li>
        ))}
        {!parts.length && <li className="muted">Nenhuma partitura salva.</li>}
      </ul>
    </>
  );
}

function Settings() {
  const settings = useStore((s) => s.config?.settings);
  const version = useStore((s) => s.version);
  const helper = useStore((s) => s.helper);
  if (!settings) return null;
  const save = (patch: Partial<typeof settings>) => op('settings.update', { settings: patch }).catch(err);
  return (
    <>
      <label className="field"><span>Silêncio que conta como "agente terminou" (ms)</span>
        <input type="number" min={800} max={20000} step={100} defaultValue={settings.idleMs} onBlur={(e) => save({ idleMs: Number(e.target.value) })} />
        <small>Aumente se os asks voltam antes do agente acabar.</small></label>
      <label className="field"><span>Fonte dos terminais (px)</span>
        <input type="number" min={9} max={24} defaultValue={settings.terminalFontSize} onBlur={(e) => save({ terminalFontSize: Number(e.target.value) })} />
        <small>Vale para terminais abertos depois.</small></label>
      <label className="field check"><span>Notificações do sistema</span>
        <input type="checkbox" defaultChecked={settings.notifications} onChange={(e) => save({ notifications: e.target.checked })} /></label>
      <label className="field check"><span>Ombro: resumir tarefas terminadas (Apple Intelligence, local)</span>
        <input type="checkbox" defaultChecked={settings.ombro !== false} onChange={(e) => save({ ombro: e.target.checked })} /></label>
      <hr />
      <h4>Computer use</h4>
      <p className="muted small">{helper
        ? 'Os agentes operam outros apps pelo Palco Helper, sempre com a sua autorização por tempo limitado. Na primeira vez, o macOS pede para liberar o "Palco Helper" em Acessibilidade e em Gravação de Tela.'
        : 'Palco Helper ausente: reinstale com ./scripts/install.sh (precisa de macOS com swiftc).'}</p>
      {helper && <button onClick={() => cli(['computer', 'trust']).then((r) => toast(r.out, 'Acessibilidade'))}>Pedir permissão de Acessibilidade ao macOS</button>}
      <hr />
      <button onClick={async () => {
        const r = await op<{ message: string }>('import.maestri').catch((e) => ({ message: (e as Error).message }));
        toast(r.message, 'Importação');
      }}>Importar workspaces do Maestri (~/.maestri)</button>
      <p className="muted small">Lê terminais, notas e cordas; não altera nada no Maestri.</p>
      <hr />
      <p className="muted small">Palco {version} · dados em ~/.palco · serviço: <code>palco status</code></p>
    </>
  );
}

function Help() {
  const [text, setText] = useState('');
  useEffect(() => { cli(['help']).then((r) => setText(r.out)).catch(() => {}); }, []);
  return (
    <>
      <h4>Atalhos</h4>
      <ul className="keys">
        <li><kbd>⌘K</kbd> compositor</li>
        <li><kbd>⌘1</kbd>…<kbd>⌘9</kbd> trocar de workspace</li>
        <li><kbd>⌥⌘T</kbd> novo terminal (primeiro preset)</li>
        <li><kbd>⌥⌘N</kbd> nova nota</li>
        <li><kbd>⌥⌘L</kbd> conectar os dois cards selecionados</li>
        <li><kbd>⌥⌘B</kbd> band com os terminais selecionados</li>
        <li><kbd>Delete</kbd> remove a seleção · <kbd>Esc</kbd> sai do desenho</li>
        <li>Botão direito no canvas: menu de adicionar · duplo clique no título: renomear</li>
      </ul>
      <h4>CLI dos agentes</h4>
      <pre className="small help">{text || 'carregando…'}</pre>
      <p className="muted small">Dentro de qualquer terminal do Palco, <code>palco</code> já está no PATH. {getState().home ? '' : ''}</p>
    </>
  );
}
