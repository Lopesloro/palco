import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CONFIG_FILE, PALCO_HOME, WORKSPACES_DIR, wsDir } from './paths.js';
import type { ChatEntry, Config, Floor, PalcoNode, Preset, Workspace } from './types.js';

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

const COLORS = ['#e8a33d', '#4f9dde', '#5fb37a', '#c66bd1', '#e06464', '#3fb8b0', '#9a8cf0'];
export const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

export function defaultPresets(): Preset[] {
  const p = (name: string, command: string, agentType: Preset['agentType'], color: string): Preset => ({
    id: uid(), name, command, agentType, chat: false, quickStart: true, maestro: false, color,
  });
  return [
    p('Claude Code', 'claude', 'claude_code', '#e8a33d'),
    p('Codex', 'codex', 'codex', '#5fb37a'),
    p('OpenCode', 'opencode', 'opencode', '#4f9dde'),
    p('Gemini', 'gemini', 'gemini', '#9a8cf0'),
    p('Shell', '', 'shell', '#8a8f98'),
  ];
}

function atomicWrite(file: string, data: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export class Store extends EventEmitter {
  config!: Config;
  workspaces = new Map<string, Workspace>();
  private timers = new Map<string, NodeJS.Timeout>();

  load() {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(PALCO_HOME, 0o700);
    if (fs.existsSync(CONFIG_FILE)) {
      this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const defaults: Config['settings'] = { idleMs: 2500, terminalFontSize: 13, theme: 'system', notifications: true };
      this.config.settings = Object.assign(defaults, this.config.settings);
      this.config.partituras ??= [];
      this.config.roles ??= [];
      this.config.workspaceOrder ??= [];
    } else {
      this.config = {
        version: 1,
        token: crypto.randomBytes(32).toString('hex'),
        port: Number(process.env.PALCO_PORT) || 4747,
        presets: defaultPresets(),
        roles: [],
        partituras: [],
        workspaceOrder: [],
        settings: { idleMs: 2500, terminalFontSize: 13, theme: 'system', notifications: true },
      };
      this.saveConfig();
    }
    for (const id of fs.readdirSync(WORKSPACES_DIR)) {
      const f = path.join(wsDir(id), 'workspace.json');
      if (!fs.existsSync(f)) continue;
      try {
        const ws = JSON.parse(fs.readFileSync(f, 'utf8')) as Workspace;
        ws.viewport ??= {};
        ws.roles ??= [];
        ws.routines ??= [];
        this.workspaces.set(ws.id, ws);
      } catch (err) {
        console.error(`[store] skipping unreadable workspace ${id}:`, err);
      }
    }
    if (this.workspaces.size === 0) {
      this.createWorkspace('Meu Workspace', process.env.HOME || '/');
    }
    this.config.workspaceOrder = [
      ...this.config.workspaceOrder.filter((id) => this.workspaces.has(id)),
      ...[...this.workspaces.keys()].filter((id) => !this.config.workspaceOrder.includes(id)),
    ];
  }

  saveConfig() {
    atomicWrite(CONFIG_FILE, JSON.stringify(this.config, null, 2), 0o600);
    this.emit('config');
  }

  /** Persist now-ish and notify listeners that the workspace changed. */
  touch(ws: Workspace) {
    this.emit('workspace', ws);
    clearTimeout(this.timers.get(ws.id));
    this.timers.set(ws.id, setTimeout(() => this.flush(ws.id), 250));
  }

  flush(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const ws = this.workspaces.get(id);
    if (ws) atomicWrite(path.join(wsDir(id), 'workspace.json'), JSON.stringify(ws, null, 2));
  }

  flushAll() {
    for (const id of [...this.timers.keys()]) this.flush(id);
  }

  orderedWorkspaces() {
    return this.config.workspaceOrder.map((id) => this.workspaces.get(id)!).filter(Boolean);
  }

  createWorkspace(name: string, dir: string): Workspace {
    const ground: Floor = { id: uid(), name: 'Térreo', dir, ground: true, git: false, createdAt: now() };
    const ws: Workspace = {
      id: uid(), name: this.uniqueWorkspaceName(name), dir, createdAt: now(), lastOpenedAt: now(),
      floors: [ground], nodes: [], edges: [], viewport: {}, roles: [], routines: [],
    };
    this.workspaces.set(ws.id, ws);
    this.config.workspaceOrder.push(ws.id);
    this.saveConfig();
    this.flush(ws.id);
    this.touch(ws);
    return ws;
  }

  deleteWorkspace(id: string) {
    this.workspaces.delete(id);
    this.config.workspaceOrder = this.config.workspaceOrder.filter((x) => x !== id);
    this.saveConfig();
    fs.rmSync(wsDir(id), { recursive: true, force: true });
    this.emit('workspace-deleted', id);
  }

  uniqueWorkspaceName(name: string) {
    const taken = new Set([...this.workspaces.values()].map((w) => w.name.toLowerCase()));
    let n = name, i = 2;
    while (taken.has(n.toLowerCase())) n = `${name} (${i++})`;
    return n;
  }

  /** Names are unique per workspace across agents, notes, portals and bands. */
  uniqueNodeName(ws: Workspace, name: string, exceptId?: string) {
    const taken = new Set(
      ws.nodes.filter((n) => n.id !== exceptId && n.type !== 'drawing')
        .map((n) => String((n.data as { name?: string }).name || '').toLowerCase()),
    );
    let out = name.trim() || 'Sem nome', i = 2;
    const base = out;
    while (taken.has(out.toLowerCase())) out = `${base} (${i++})`;
    return out;
  }

  findWorkspaceOfNode(nodeId: string): { ws: Workspace; node: PalcoNode } | undefined {
    for (const ws of this.workspaces.values()) {
      const node = ws.nodes.find((n) => n.id === nodeId);
      if (node) return { ws, node };
    }
    return undefined;
  }

  // ---- notes -------------------------------------------------------------
  notePath(wsId: string, nodeId: string) {
    return path.join(wsDir(wsId), 'notes', `${nodeId}.md`);
  }
  readNote(wsId: string, nodeId: string) {
    const f = this.notePath(wsId, nodeId);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
  writeNote(wsId: string, nodeId: string, content: string) {
    atomicWrite(this.notePath(wsId, nodeId), content);
    this.emit('note', wsId, nodeId, content);
  }
  deleteNoteFile(wsId: string, nodeId: string) {
    fs.rmSync(this.notePath(wsId, nodeId), { force: true });
  }

  // ---- chat --------------------------------------------------------------
  chatPath(wsId: string, nodeId: string) {
    return path.join(wsDir(wsId), 'chat', `${nodeId}.jsonl`);
  }
  appendChat(wsId: string, nodeId: string, entry: Omit<ChatEntry, 'id' | 'ts'>) {
    const full: ChatEntry = { id: uid(), ts: now(), ...entry };
    const f = this.chatPath(wsId, nodeId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(full) + '\n');
    this.emit('chat', wsId, nodeId, full);
    return full;
  }
  readChat(wsId: string, nodeId: string, limit = 300): ChatEntry[] {
    const f = this.chatPath(wsId, nodeId);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((l) => {
      try { return [JSON.parse(l) as ChatEntry]; } catch { return []; }
    });
  }

  scrollbackPath(wsId: string, nodeId: string) {
    return path.join(wsDir(wsId), 'scrollback', `${nodeId}.log`);
  }
}
