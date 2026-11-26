import { useSyncExternalStore } from 'react';
import { connect, onMessage, token } from './api';
import type { ChatEntry, Config, Workspace } from './types';

export type Status = 'starting' | 'busy' | 'idle' | 'attention' | 'exited';

export interface Activity {
  id: number;
  at: string;
  kind: 'ask' | 'reply' | 'done' | 'say' | 'note' | 'recruit' | 'connect' | 'blocked' | 'user';
  from?: string;
  to?: string;
  fromId?: string;
  toId?: string;
  wsId?: string;
  text: string;
}

export interface OmbroEntry { id: string; nodeId: string; wsId: string; name: string; ts: string; text: string }
export interface ComputerState {
  grants: { nodeId: string; name: string; until: string }[];
  pending: { id: string; nodeId: string; name: string; action: string; at: string }[];
}

export interface State {
  connected: boolean;
  ready: boolean;
  version: string;
  home: string;
  helper: boolean;
  config?: Omit<Config, 'token'>;
  workspaces: Workspace[];
  currentWs?: string;
  currentFloor: Record<string, string>;
  statuses: Record<string, Status>;
  attention: Record<string, string | undefined>;
  notes: Record<string, string>;
  chats: Record<string, ChatEntry[]>;
  toasts: { id: number; title: string; text: string }[];
  panel?: 'routines' | 'roles' | 'presets' | 'partituras' | 'settings' | 'help';
  side?: 'activity' | 'ombro';
  tool: 'select' | 'pen' | 'arrow' | 'rect';
  focusNode?: { id: string; at: number };
  selection: string[];
  activity: Activity[];
  /** node id pairs that just exchanged something, for the rope pulse */
  pulses: Record<string, number>;
  computer: ComputerState;
  driving?: { name: string; action: string; at: number };
  ombro: OmbroEntry[];
}

let state: State = {
  connected: false,
  ready: false,
  version: '',
  home: '',
  helper: false,
  workspaces: [],
  currentWs: localStorage.getItem('palco.ws') ?? undefined,
  currentFloor: JSON.parse(localStorage.getItem('palco.floors') ?? '{}'),
  statuses: {},
  attention: {},
  notes: {},
  chats: {},
  toasts: [],
  side: (localStorage.getItem('palco.side') as State['side']) ?? 'activity',
  tool: 'select',
  selection: [],
  activity: [],
  pulses: {},
  computer: { grants: [], pending: [] },
  ombro: [],
};

const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.currentWs) localStorage.setItem('palco.ws', p.currentWs);
  if (p.currentFloor) localStorage.setItem('palco.floors', JSON.stringify(p.currentFloor));
  if ('side' in p) localStorage.setItem('palco.side', p.side ?? '');
  for (const s of subs) s();
}
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export const currentWorkspace = (s: State) => s.workspaces.find((w) => w.id === s.currentWs) ?? s.workspaces[0];
export const currentFloorId = (s: State, ws?: Workspace) => {
  if (!ws) return undefined;
  const f = s.currentFloor[ws.id];
  return ws.floors.some((x) => x.id === f) ? f : ws.floors.find((x) => x.ground)?.id;
};

export const pairKey = (a?: string, b?: string) => [a ?? '', b ?? ''].sort().join('|');

let toastId = 0;
export function toast(text: string, title = 'Palco') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, title, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
}

function pulse(a?: string, b?: string) {
  if (!a || !b) return;
  const key = pairKey(a, b);
  setState((s) => ({ pulses: { ...s.pulses, [key]: Date.now() } }));
  setTimeout(() => setState((s) => {
    if (Date.now() - (s.pulses[key] ?? 0) < 2400) return {};
    const { [key]: _gone, ...rest } = s.pulses;
    void _gone;
    return { pulses: rest };
  }), 2600);
}

export function boot() {
  if (!token) return; // the splash screen explains how to open Palco with its token
  onMessage((m) => {
    switch (m.t) {
      case 'open': setState({ connected: true }); break;
      case 'closed': setState({ connected: false }); break;
      case 'hello': {
        const ws: Workspace[] = m.workspaces;
        setState((s) => ({
          ready: true, version: m.version, home: m.home ?? '', config: m.config, workspaces: ws, statuses: m.statuses,
          helper: !!m.helper, computer: m.computer ?? s.computer, ombro: m.ombro ?? [], activity: m.activity ?? [],
          attention: m.attention ?? {},
          currentWs: ws.some((w) => w.id === s.currentWs) ? s.currentWs : ws[0]?.id,
        }));
        break;
      }
      case 'workspace': setState((s) => {
        const i = s.workspaces.findIndex((w) => w.id === m.ws.id);
        const next = [...s.workspaces];
        if (i >= 0) next[i] = m.ws; else next.push(m.ws);
        return { workspaces: next };
      }); break;
      case 'workspace-deleted': setState((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== m.id);
        return { workspaces, currentWs: s.currentWs === m.id ? workspaces[0]?.id : s.currentWs };
      }); break;
      case 'config': setState({ config: m.config }); break;
      case 'status': setState((s) => ({ statuses: { ...s.statuses, [m.id]: m.status }, attention: { ...s.attention, [m.id]: m.attention } })); break;
      case 'note': setState((s) => ({ notes: { ...s.notes, [m.nodeId]: m.content } })); break;
      case 'chat': setState((s) => ({ chats: { ...s.chats, [m.nodeId]: [...(s.chats[m.nodeId] ?? []), m.entry] } })); break;
      case 'notify': toast(m.text, m.title); break;
      case 'activity': {
        const a = m.a as Activity;
        setState((s) => ({ activity: [...s.activity.slice(-299), a] }));
        pulse(a.fromId, a.toId);
        break;
      }
      case 'computer': setState({ computer: { grants: m.grants ?? [], pending: m.pending ?? [] } }); break;
      case 'computer-activity': setState({ driving: { name: m.name, action: m.action, at: Date.now() } }); break;
      case 'ombro': setState((s) => ({ ombro: [m.entry, ...s.ombro].slice(0, 40) })); break;
    }
  });
  connect();
}
