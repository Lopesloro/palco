import { useSyncExternalStore } from 'react';
import { connect, onMessage, token } from './api';
import type { ChatEntry, Config, Workspace } from './types';

export type Status = 'starting' | 'busy' | 'idle' | 'exited';

export interface State {
  connected: boolean;
  ready: boolean;
  version: string;
  home: string;
  config?: Omit<Config, 'token'>;
  workspaces: Workspace[];
  currentWs?: string;
  currentFloor: Record<string, string>;
  statuses: Record<string, Status>;
  notes: Record<string, string>;
  chats: Record<string, ChatEntry[]>;
  toasts: { id: number; title: string; text: string }[];
  panel?: 'routines' | 'roles' | 'presets' | 'partituras' | 'settings' | 'help';
  tool: 'select' | 'pen' | 'arrow' | 'rect';
  focusNode?: { id: string; at: number };
  selection: string[];
}

let state: State = {
  connected: false,
  ready: false,
  version: '',
  home: '',
  workspaces: [],
  currentWs: localStorage.getItem('palco.ws') ?? undefined,
  currentFloor: JSON.parse(localStorage.getItem('palco.floors') ?? '{}'),
  statuses: {},
  notes: {},
  chats: {},
  toasts: [],
  tool: 'select',
  selection: [],
};

const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.currentWs) localStorage.setItem('palco.ws', p.currentWs);
  if (p.currentFloor) localStorage.setItem('palco.floors', JSON.stringify(p.currentFloor));
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

let toastId = 0;
export function toast(text: string, title = 'Palco') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, title, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
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
      case 'status': setState((s) => ({ statuses: { ...s.statuses, [m.id]: m.status } })); break;
      case 'note': setState((s) => ({ notes: { ...s.notes, [m.nodeId]: m.content } })); break;
      case 'chat': setState((s) => ({ chats: { ...s.chats, [m.nodeId]: [...(s.chats[m.nodeId] ?? []), m.entry] } })); break;
      case 'notify': toast(m.text, m.title); break;
    }
  });
  connect();
}
