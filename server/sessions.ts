import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { CLI_BIN_DIR } from './paths.js';
import { mailboxDir } from './mailbox.js';
import type { Store } from './store.js';
import type { PalcoNode, TerminalData, Workspace } from './types.js';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const REPLAY_LIMIT = 1_000_000;
export type SessionStatus = 'starting' | 'busy' | 'idle' | 'attention' | 'exited';

/**
 * Screens that are a decision for the human, never for an agent or for Palco: folder trust,
 * self-updates, permission prompts, yes/no questions, numbered menus. Typing a prompt plus Enter
 * into one of these picks the highlighted option (often "exit" or "update now").
 */
const ATTENTION: [RegExp, string][] = [
  [/do you trust|trust (this|the) (folder|files|directory|contents)/i, 'pergunta se confia na pasta'],
  [/^\s*[›❯>]\s*1[.)]\s+\S/m, 'mostra um menu de opções'],
  [/press enter to continue|enter to confirm/i, 'espera uma confirmação'],
  [/\((y\/n|yes\/no)\)\s*:?\s*$|\[(y\/n|Y\/n|y\/N)\]\s*:?\s*$/m, 'faz uma pergunta de sim ou não'],
];

/** Why this screen needs the human, if it does. Only the bottom of the screen is considered. */
export function attentionReason(screen: string): string | undefined {
  const tail = screen.split('\n').slice(-16).join('\n');
  return ATTENTION.find(([re]) => re.test(tail))?.[1];
}

const RULE = /^\s*[─━═-]{20,}\s*$/;

/** Removes a TUI's input box and status bar from the bottom of a transcript. */
function dropInputBox(lines: string[]): string[] {
  // everything from the second-to-last horizontal rule near the bottom (Claude Code)
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0 && i >= lines.length - 14);
  if (rules.length >= 2) lines = lines.slice(0, rules[rules.length - 2]);
  else if (rules.length === 1) lines = lines.slice(0, rules[0]);
  // TUIs without rules (Codex): the trailing input line ("› …") and the status under it
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (/^\s*[›❯]\s/.test(lines[i])) { lines = lines.slice(0, i); break; }
  }
  return lines;
}

/** Transcript without the input box: what the agent actually did, for summaries. */
export function withoutInputBox(transcript: string) {
  return dropInputBox(transcript.split('\n')).join('\n').trim();
}

/**
 * Pulls the agent's answer out of a terminal transcript: what came after the prompt we typed,
 * without the TUI's input box and status bar at the bottom.
 */
export function extractReply(transcript: string, prompt: string): string {
  let lines = transcript.split('\n');
  const key = prompt.split('\n').map((l) => l.trim()).find((l) => l.length > 3)?.slice(0, 40);
  if (key) {
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(key)) { at = i; break; }
    if (at >= 0) {
      // skip the rest of the echoed prompt (it may wrap over several lines)
      const promptLines = prompt.split('\n').length;
      let j = at + 1;
      while (j < lines.length && j < at + promptLines + 6 && /^\s{2,}\S/.test(lines[j]) && !/^\s*[⏺●•]/.test(lines[j])) j++;
      lines = lines.slice(j);
    }
  }
  lines = dropInputBox(lines);
  // Claude (⏺) and Codex (•) mark each message; keep the agent's last real message, not tool calls
  const TOOL = /^\s*[⏺•●]\s+(Ran\b|Explored\b|Working\b|Edited\b|Searched\b|Called\b|(Bash|Read|Edit|MultiEdit|Write|Update|Skill|Task|Agent|Grep|Glob|LS|WebFetch|WebSearch|TodoWrite|NotebookEdit|mcp__[\w-]+)\()/;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[⏺•●]\s+\S/.test(lines[i]) && !TOOL.test(lines[i])) { lines = lines.slice(i); break; }
  }
  while (lines.length && (/^\s*✻\s/.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
  const out = lines.join('\n').replace(/^\s*[•⏺●]\s?/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return out || transcript.split('\n').slice(-30).join('\n').trim();
}

export const PALCO_PREAMBLE = `Você está num terminal do Palco, um canvas local onde agentes, notas e navegadores são ligados por cordas.
- O comando \`palco\` está no PATH. Rode \`palco list\` para ver seu nome e com quem está ligado (agentes, notas, portais).
- Mensagens que começam com "[Palco] Mensagem de ..." vêm de outro agente. Faça o que pedem e, se for uma tarefa, devolva o resultado com \`palco ask "<nome dele>" "<resultado>"\`.
- Mensagens com o cabeçalho "Palco Chat" vêm do usuário pela janela de chat: responda só com \`palco say\`.
- Para falar com outro agente: \`palco ask "Nome" "pedido"\` (espera a resposta; ajuste o timeout da sua ferramenta de shell para até 10 min).
- Notas ligadas a você: \`palco note read/edit/write "Nome"\`. A skill "palco" tem todos os comandos.`;

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
  /** Last time the *visible content* changed. TUIs that repaint an identical frame do not count. */
  lastOutputAt = 0;
  /** Increments on every content change; immune to millisecond clock ties. */
  outputSeq = 0;
  lastByteAt = 0;
  attention?: string;
  private lastSig = '';
  private diffTimer?: NodeJS.Timeout;
  startedAt = Date.now();
  exited = false;
  exitCode?: number;
  status: SessionStatus = 'starting';
  cols = 120;
  rows = 36;
  pendingInitialPrompt?: string;
  /** Identifies this terminal to the server; agents never see the master token. */
  token = crypto.randomBytes(24).toString('hex');

  constructor(public wsId: string, public nodeId: string) {
    super();
  }

  write(data: string) {
    if (this.pty && !this.exited) this.pty.write(data);
  }

  /** Called after output is parsed; marks activity only when the screen really changed. */
  noteOutput() {
    this.lastByteAt = Date.now();
    if (this.diffTimer) return;
    this.diffTimer = setTimeout(() => {
      this.diffTimer = undefined;
      // Visible text only: some TUIs scroll and repaint an identical frame every second, which grows
      // the scrollback without anything new to read. That must not count as work.
      const sig = this.screen();
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        this.lastOutputAt = Date.now();
        this.outputSeq++;
      }
    }, 60);
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
    let end = buf.viewportY + this.term.rows;
    // count from the last line with text, not from the blank bottom of the screen
    while (end > 0 && !(buf.getLine(end - 1)?.translateToString(true) ?? '').trim()) end--;
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
      else if (t - s.lastOutputAt < this.idleMs) next = 'busy';
      else {
        s.attention = attentionReason(s.screen());
        next = s.attention ? 'attention' : 'idle';
      }
      if (next !== s.status) {
        if (next === 'attention') this.emit('attention', s.wsId, s.nodeId, s.attention);
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

  /** The terminal a per-session token belongs to (constant-time compare). */
  byToken(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const a = Buffer.from(token);
    for (const s of this.sessions.values()) {
      const b = Buffer.from(s.token);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return s;
    }
    return undefined;
  }

  buildCommand(ws: Workspace, data: TerminalData): { file: string; args: string[] } {
    const shell = process.env.SHELL || '/bin/zsh';
    let cmd = data.command.trim();
    const role = data.roleId ? this.findRole(ws, data.roleId) : undefined;
    if (cmd && data.agentType === 'claude_code' && !/--append-system-prompt/.test(cmd)) {
      // Every Claude starts knowing it lives in Palco and how to talk to its peers.
      const parts = [PALCO_PREAMBLE, role ? rolePreamble(role.name, role.prompt) : ''].filter(Boolean).join('\n\n');
      cmd += ` --append-system-prompt ${shellQuote(parts)}`;
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
      PALCO_TOKEN: s.token,
      PALCO_TERMINAL_ID: node.id,
      PALCO_CLI: path.join(CLI_BIN_DIR, 'palco'),
      PALCO_MAILBOX: mailboxDir(),
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
    if (role && data.command.trim() && (data.agentType !== 'claude_code' || /--append-system-prompt/.test(data.command))) {
      s.pendingInitialPrompt = rolePreamble(role.name, role.prompt);
    }

    s.pty.onData((d) => {
      s.term.write(d, () => s.noteOutput());
      s.replay += d;
      if (s.replay.length > REPLAY_LIMIT) s.replay = s.replay.slice(-REPLAY_LIMIT * 0.8);
      this.emit('data', ws.id, node.id, d);
      s.emit('data', d);
    });
    // The headless terminal answers device queries (cursor position, device attributes) so TUIs
    // like Codex work even when no browser is watching. The browser's own answers are dropped.
    s.term.onData((reply) => s.write(reply));
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
