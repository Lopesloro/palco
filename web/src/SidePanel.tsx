import { useEffect, useMemo, useRef, useState } from 'react';
import { op } from './api';
import { setState, toast, useStore, type Activity } from './store';
import type { Workspace } from './types';

const KIND: Record<Activity['kind'], { icon: string; verb: string }> = {
  user: { icon: '›', verb: 'para' },
  ask: { icon: '→', verb: 'pergunta a' },
  reply: { icon: '↩', verb: 'responde a' },
  done: { icon: '✓', verb: 'terminou para' },
  say: { icon: '💬', verb: 'diz a' },
  note: { icon: '📝', verb: '→' },
  recruit: { icon: '＋', verb: 'recrutou' },
  connect: { icon: '⟷', verb: 'ligou a' },
  blocked: { icon: '⚠', verb: 'não enviou a' },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ActivityItem({ a }: { a: Activity }) {
  const [open, setOpen] = useState(false);
  const k = KIND[a.kind] ?? KIND.ask;
  const focus = (id?: string) => id && setState({ focusNode: { id, at: Date.now() } });
  const long = a.text.length > 160 || a.text.includes('\n');
  return (
    <li className={`act act-${a.kind}`}>
      <div className="act-head">
        <span className="act-icon">{k.icon}</span>
        <button className="link" onClick={() => focus(a.fromId)}>{a.from ?? '—'}</button>
        <span className="muted">{k.verb}</span>
        <button className="link" onClick={() => focus(a.toId)}>{a.to ?? '—'}</button>
        <span className="spacer" />
        <span className="muted small">{time(a.at)}</span>
      </div>
      {a.kind !== 'connect' && a.kind !== 'recruit' && (
        <div className={`act-body ${open ? 'open' : ''}`} onClick={() => long && setOpen(!open)} title={long ? (open ? 'recolher' : 'expandir') : undefined}>
          {a.text}
        </div>
      )}
    </li>
  );
}

function ActivityList({ ws }: { ws: Workspace }) {
  const all = useStore((s) => s.activity);
  const [filter, setFilter] = useState<'all' | 'talk'>('all');
  const list = useMemo(() => all.filter((a) => (!a.wsId || a.wsId === ws.id) && (filter === 'all' || ['ask', 'reply', 'done', 'say', 'user', 'blocked'].includes(a.kind))), [all, ws.id, filter]);
  const end = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => { if (stick) end.current?.scrollIntoView({ block: 'end' }); }, [list.length, stick]);
  return (
    <>
      <div className="seg">
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Tudo</button>
        <button className={filter === 'talk' ? 'on' : ''} onClick={() => setFilter('talk')}>Só conversas</button>
      </div>
      <div className="side-scroll" onScroll={(e) => { const el = e.currentTarget; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}>
        {list.length === 0 ? (
          <div className="side-empty">
            <b>Nada trafegou ainda.</b>
            <p>Quando um agente perguntar a outro, responder, escrever numa nota ou falar com você, aparece aqui, e a corda entre eles pisca no canvas.</p>
          </div>
        ) : (
          <ul className="act-list">{list.map((a) => <ActivityItem key={a.id} a={a} />)}</ul>
        )}
        <div ref={end} />
      </div>
    </>
  );
}

function OmbroList({ ws }: { ws: Workspace }) {
  const entries = useStore((s) => s.ombro);
  const helper = useStore((s) => s.helper);
  const enabled = useStore((s) => s.config?.settings.ombro !== false);
  const list = entries.filter((e) => e.wsId === ws.id);
  return (
    <div className="side-scroll">
      {!helper && <div className="side-empty"><b>Ombro indisponível.</b><p>Precisa do Palco Helper (macOS com Apple Intelligence). Reinstale com ./scripts/install.sh.</p></div>}
      {helper && !enabled && <div className="side-empty"><b>Ombro desligado.</b><p>Ligue em Configurações.</p></div>}
      {helper && enabled && list.length === 0 && (
        <div className="side-empty">
          <b>Ombro está de olho.</b>
          <p>Quando um agente terminar um trabalho de mais de 15 segundos, o Ombro resume o que ele fez e sugere o próximo passo, usando o modelo local da Apple. Nada sai do seu Mac.</p>
        </div>
      )}
      <ul className="ombro-list">
        {list.map((e) => (
          <li key={e.id}>
            <div className="act-head">
              <button className="link" onClick={() => setState({ focusNode: { id: e.nodeId, at: Date.now() } })}>{e.name}</button>
              <span className="spacer" />
              <span className="muted small">{time(e.ts)}</span>
              <button className="ghost tiny" title="Dispensar" onClick={() => { void op('ombro.dismiss', { id: e.id }); setState((s) => ({ ombro: s.ombro.filter((x) => x.id !== e.id) })); }}>✕</button>
            </div>
            <div className="ombro-text">{e.text}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SidePanel({ ws }: { ws: Workspace }) {
  const side = useStore((s) => s.side);
  if (!side) return null;
  return (
    <aside className="sidepanel">
      <header>
        <div className="seg big">
          <button className={side === 'activity' ? 'on' : ''} onClick={() => setState({ side: 'activity' })}>Atividade</button>
          <button className={side === 'ombro' ? 'on' : ''} onClick={() => setState({ side: 'ombro' })}>Ombro</button>
        </div>
        <span className="spacer" />
        <button className="ghost" title="Fechar painel" onClick={() => setState({ side: undefined })}>✕</button>
      </header>
      {side === 'activity' ? <ActivityList ws={ws} /> : <OmbroList ws={ws} />}
    </aside>
  );
}

/** Computer-use consent: pending requests, who is driving right now, and the stop-all switch. */
export function ComputerBar() {
  const { pending, grants } = useStore((s) => s.computer);
  const driving = useStore((s) => s.driving);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const recent = driving && Date.now() - driving.at < 4000;
  const decide = (id: string, allow: boolean, minutes = 15) => op('computer.decide', { id, allow, minutes }).catch((e) => toast((e as Error).message));
  if (!pending.length && !grants.length && !recent) return null;
  return (
    <div className="computer-bar">
      {pending.map((p) => (
        <div key={p.id} className="consent">
          <div><b>{p.name}</b> quer controlar o computador</div>
          <div className="muted small">primeira ação: {p.action}</div>
          <div className="consent-actions">
            <button className="primary" onClick={() => decide(p.id, true, 15)}>Permitir 15 min</button>
            <button onClick={() => decide(p.id, true, 60)}>1 hora</button>
            <button className="ghost" onClick={() => decide(p.id, false)}>Negar</button>
          </div>
        </div>
      ))}
      {(grants.length > 0 || recent) && (
        <div className="driving">
          <span className="dot st-busy" />
          {recent ? <span><b>{driving!.name}</b> está usando o computador: {driving!.action}</span> : <span>{grants.map((g) => g.name).join(', ')} pode(m) usar o computador</span>}
          <span className="spacer" />
          <button className="danger" onClick={() => op('computer.revokeAll').then(() => toast('Computer use parado para todos.'))}>Parar tudo</button>
        </div>
      )}
    </div>
  );
}
