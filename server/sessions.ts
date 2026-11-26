import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { CLI_BIN_DIR } from './paths.js';
import type { Store } from './store.js';
import type { PalcoNode, TerminalData, Workspace } from './types.js';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const REPLAY_LIMIT = 1_000_000;
export type SessionStatus = 'starting' | 'busy' | 'idle' | 'exited';

/** node-pty ships its macOS spawn-helper without the exec bit when install scripts are skipped. */
export function ensureSpawnHelper() {
  try {
    const base = path.dirname(require.resolve('node-pty/package.json'));
    for (const dir of ['prebuilds', 'build/Release']) {
      const root = path.join(base, dir);
      if (!fs.existsSync(root)) continue;
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === 'spawn-helper') fs.chmodSync(p, 0o755);
        }
      };
      walk(root);
    }
  } catch (err) {
    console.error('[sessions] could not fix spawn-helper permissions:', err);
  }
}

export function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class Session extends EventEmitter {
  pty?: IPty;
  term = new HeadlessTerminal({ cols: 120, rows: 36, scrollback: 5000, allowProposedApi: true });
  replay = '';
  lastOutputAt = 0;
  /** Increments on every output chunk; immune to millisecond clock ties. */
  outputSeq = 0;
  startedAt = Date.now();
  exited = false;
  exitCode?: number;
  status: SessionStatus = 'starting';
  cols = 120;
  rows = 36;
  pendingInitialPrompt?: string;

  constructor(public wsId: string, public nodeId: string) {
    super();
  }

  write(data: string) {
    if (this.pty && !this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    if (!cols || !rows || (cols === this.cols && rows === this.rows)) return;
    this.cols = Math.max(20, Math.min(cols, 500));
    this.rows = Math.max(5, Math.min(rows, 200));
    this.term.resize(this.cols, this.rows);
    if (this.pty && !this.exited) this.pty.resize(this.cols, this.rows);
  }

  /** Visible screen as plain text (what the agent is "showing"). */
  screen(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.viewportY; i < buf.viewportY + this.term.rows; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }

  /** Last n lines of the scrollback + screen. */
  tail(n = 200): string {
    const buf = this.term.buffer.active;
    const end = buf.viewportY + this.term.rows;
    const lines: string[] = [];
    for (let i = Math.max(0, end - n); i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }
}

export class SessionManager extends EventEmitter {
  sessions = new Map<string, Session>();
  private tick: NodeJS.Timeout;

  constructor(private store: Store, private serverUrl: () => string) {
    super();
    ensureSpawnHelper();
    this.tick = setInterval(() => this.refreshStatuses(), 500);
    this.tick.unref();
  }

  get idleMs() {
    return this.store.config.settings.idleMs;
  }

  refreshStatuses() {
    const t = Date.now();
    for (const s of this.sessions.values()) {
      let next: SessionStatus;
      if (s.exited) next = 'exited';
      else if (s.lastOutputAt === 0 && t - s.startedAt < 4000) next = 'starting';
      else next = t - s.lastOutputAt < this.idleMs ? 'busy' : 'idle';
      if (next !== s.status) {
        s.status = next;
        this.emit('status', s.wsId, s.nodeId, next);
        s.emit('status', next);
        if (next === 'idle' && s.pendingInitialPrompt) {
          const p = s.pendingInitialPrompt;
          s.pendingInitialPrompt = undefined;
          typePrompt(s, p);
        }
      }
    }
  }

  get(nodeId: string) {
    return this.sessions.get(nodeId);
  }

  buildCommand(ws: Workspace, data: TerminalData): { file: string; args: string[] } {
    const shell = process.env.SHELL || '/bin/zsh';
    let cmd = data.command.trim();
    const role = data.roleId ? this.findRole(ws, data.roleId) : undefined;
    if (cmd && role && data.agentType === 'claude_code') {
      cmd += ` --append-system-prompt ${shellQuote(rolePreamble(role.name, role.prompt))}`;
    }
    if (!cmd) return { file: shell, args: ['-l', '-i'] };
    // Run the agent inside a login shell, then drop back to an interactive shell when it exits.
    return { file: shell, args: ['-l', '-i', '-c', `${cmd}; exec ${shellQuote(shell)} -l -i`] };
  }

  findRole(ws: Workspace, roleId: string) {
    return ws.roles.find((r) => r.id === roleId) || this.store.config.roles.find((r) => r.id === roleId);
  }

  start(ws: Workspace, node: PalcoNode) {
    const data = node.data as TerminalData;
    this.stop(node.id, false);
    const s = new Session(ws.id, node.id);
    this.sessions.set(node.id, s);

    const prev = this.store.scrollbackPath(ws.id, node.id);
    if (fs.existsSync(prev)) {
      const old = fs.readFileSync(prev, 'utf8');
      s.replay = old.slice(-200_000) + '\r\n\x1b[2m── sessão reiniciada ──\x1b[0m\r\n';
    }

    const cwd = fs.existsSync(data.cwd) ? data.cwd : os.homedir();
    const { file, args } = this.buildCommand(ws, data);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Palco',
      LANG: process.env.LANG || 'en_US.UTF-8',
      PALCO_URL: this.serverUrl(),
      PALCO_TOKEN: this.store.config.token,
      PALCO_TERMINAL_ID: node.id,
      PALCO_CLI: path.join(CLI_BIN_DIR, 'palco'),
      PATH: `${CLI_BIN_DIR}:${process.env.PATH || '/usr/bin:/bin'}`,
    };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    try {
      s.pty = pty.spawn(file, args, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd, env });
    } catch (err) {
      s.exited = true;
      s.status = 'exited';
      const msg = `\r\n\x1b[31mFalha ao iniciar: ${(err as Error).message}\x1b[0m\r\n`;
      s.replay += msg;
      this.emit('data', ws.id, node.id, msg);
      return s;
    }

    const role = data.roleId ? this.findRole(ws, data.roleId) : undefined;
    if (role && data.agentType !== 'claude_code' && data.command.trim()) {
      s.pendingInitialPrompt = rolePreamble(role.name, role.prompt);
    }

    s.pty.onData((d) => {
      s.lastOutputAt = Date.now();
      s.outputSeq++;
      s.term.write(d);
      s.replay += d;
      if (s.replay.length > REPLAY_LIMIT) s.replay = s.replay.slice(-REPLAY_LIMIT * 0.8);
      this.emit('data', ws.id, node.id, d);
      s.emit('data', d);
    });
    s.pty.onExit(({ exitCode }) => {
      s.exited = true;
      s.exitCode = exitCode;
      this.persistScrollback(s);
      const msg = `\r\n\x1b[2m── processo encerrado (código ${exitCode}) ──\x1b[0m\r\n`;
      s.replay += msg;
      this.emit('data', ws.id, node.id, msg);
      this.refreshStatuses();
    });
    return s;
  }

  persistScrollback(s: Session) {
    try {
      const f = this.store.scrollbackPath(s.wsId, s.nodeId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s.replay.slice(-400_000));
    } catch (err) {
      console.error('[sessions] scrollback save failed:', err);
    }
  }

  stop(nodeId: string, removeFiles: boolean) {
    const s = this.sessions.get(nodeId);
    if (!s) return;
    this.sessions.delete(nodeId);
    if (!s.exited) {
      this.persistScrollback(s);
      try { s.pty?.kill('SIGHUP'); } catch { /* already gone */ }
    }
    if (removeFiles) fs.rmSync(this.store.scrollbackPath(s.wsId, nodeId), { force: true });
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id, false);
  }
}

export function rolePreamble(name: string, prompt: string) {
  return `<your_assigned_role name="${name.replace(/"/g, "'")}">\n${prompt}\n</your_assigned_role>`;
}

/** Decode `\n`, `\t`, `\e`, `\xNN` escapes used by `palco ask --raw`. */
export function decodeRaw(s: string) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|n|r|t|e|\\)/g, (_, c: string) => {
    if (c === 'n') return '\r';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === 'e') return '\x1b';
    if (c === '\\') return '\\';
    return String.fromCharCode(parseInt(c.slice(1), 16));
  });
}

/**
 * Agent TUIs get bracketed paste so a multi-line prompt arrives as one input, then Enter.
 * Plain shells get the text as typed: not every shell understands bracketed paste.
 */
export function typePrompt(s: Session, text: string, bracketed = true) {
  if (!bracketed) {
    s.write(`${text}\r`);
    return;
  }
  s.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => s.write('\r'), 150);
}
