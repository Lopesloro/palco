import type { ChatEntry, Config, Workspace } from './types';

const TOKEN_KEY = 'palco.token';

function readToken() {
  const m = location.hash.match(/token=([a-f0-9]{64})/);
  if (m) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export const token = readToken();
// `palco` may open the URL in a tab that already shows the app: pick up the new token.
window.addEventListener('hashchange', () => { if (/token=/.test(location.hash)) location.reload(); });

export async function op<T = unknown>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ op: name, ...body }),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.result as T;
}

/** Runs a `palco` CLI command as the human (no caller terminal). */
export async function cli(argv: string[]): Promise<{ out: string; code: number }> {
  const r = await fetch('/api/cli', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ argv }),
  });
  return r.json();
}

export async function upload(file: Blob, ext: string): Promise<string> {
  const r = await fetch(`/api/upload?ext=${encodeURIComponent(ext)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.path as string;
}

export const fileUrl = (p: string) => `/api/file?path=${encodeURIComponent(p)}&token=${token}`;

// ------------------------------------------------------------------ websocket
type Listener = (msg: any) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let queue: string[] = [];
let retry = 0;

export function onMessage(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function send(msg: unknown) {
  const s = JSON.stringify(msg);
  if (socket?.readyState === WebSocket.OPEN) socket.send(s);
  else queue.push(s);
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
  socket.onopen = () => {
    retry = 0;
    for (const s of queue) socket!.send(s);
    queue = [];
    for (const l of listeners) l({ t: 'open' });
  };
  socket.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    for (const l of listeners) l(msg);
  };
  socket.onclose = (ev) => {
    for (const l of listeners) l({ t: 'closed', code: ev.code });
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 300 * 2 ** retry);
  };
}

export type { ChatEntry, Config, Workspace };
