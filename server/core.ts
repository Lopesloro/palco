import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { Store, uid, now, randomColor } from './store.js';
import { SessionManager, typePrompt, decodeRaw, type Session } from './sessions.js';
import type {
  BandData, Edge, NodeType, NoteData, PalcoNode, PortalData, Preset, TerminalData, Workspace,
} from './types.js';

export class PalcoError extends Error {
  constructor(message: string, public code = 1) {
    super(message);
  }
}

const SIZE: Record<NodeType, [number, number]> = {
  terminal: [720, 460],
  note: [320, 300],
  portal: [900, 640],
  band: [260, 220],
  drawing: [10, 10],
};

interface Waiter {
  from: string;
  to: string;
  resolve: (text: string) => void;
}

export interface Reach {
  agents: PalcoNode<TerminalData>[];
  bands: PalcoNode<BandData>[];
  notes: { node: PalcoNode<NoteData>; depth: number }[];
  portals: PalcoNode<PortalData>[];
}

export const nameOf = (n: PalcoNode) => String((n.data as { name?: string }).name ?? '');

export class Core extends EventEmitter {
  waiters: Waiter[] = [];
  portalHook?: { close(nodeId: string): void };

  constructor(public store: Store, public sessions: SessionManager) {
    super();
  }

  // ---------------------------------------------------------------- lookups
  ws(id: string) {
    const ws = this.store.workspaces.get(id);
    if (!ws) throw new PalcoError(`Workspace não encontrado: ${id}`);
    return ws;
  }

  locate(nodeId: string) {
    const hit = this.store.findWorkspaceOfNode(nodeId);
    if (!hit) throw new PalcoError(`Nó não encontrado: ${nodeId}`);
    return hit;
  }

  wsByName(name: string) {
    const ws = [...this.store.workspaces.values()].find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (!ws) throw new PalcoError(`Workspace "${name}" não existe. Veja: palco workspace list`);
    return ws;
  }

  floorByName(ws: Workspace, name?: string) {
    if (!name) return undefined;
    const lower = name.toLowerCase();
    const f = ws.floors.find((x) => x.name.toLowerCase() === lower || (x.ground && ['ground', 'térreo', 'terreo'].includes(lower)));
    if (!f) throw new PalcoError(`Andar "${name}" não existe. Veja: palco floor list`);
    return f;
  }

  groundOf(ws: Workspace) {
    return ws.floors.find((f) => f.ground)!;
  }

  /** "Name" in the caller's workspace, or "Name @ Workspace" anywhere. */
  byName(name: string, ctxWs?: Workspace, types?: NodeType[]): { ws: Workspace; node: PalcoNode } {
    let target = name.trim();
    let ws = ctxWs;
    const at = target.lastIndexOf(' @ ');
    if (at > 0) {
      ws = this.wsByName(target.slice(at + 3).trim());
      target = target.slice(0, at).trim();
    }
    const pools = ws ? [ws] : [...this.store.workspaces.values()];
    for (const w of pools) {
      const node = w.nodes.find((n) => n.type !== 'drawing' && (!types || types.includes(n.type)) && nameOf(n).toLowerCase() === target.toLowerCase());
      if (node) return { ws: w, node };
    }
    throw new PalcoError(`"${name}" não encontrado. Rode \`palco list\` para ver os nomes exatos.`);
  }

  displayName(node: PalcoNode, from?: Workspace) {
    const hit = this.store.findWorkspaceOfNode(node.id);
    if (hit && from && hit.ws.id !== from.id) return `${nameOf(node)} @ ${hit.ws.name}`;
    return nameOf(node);
  }

  neighbors(nodeId: string): string[] {
    const out = new Set<string>();
    for (const ws of this.store.workspaces.values()) {
      for (const e of ws.edges) {
        if (e.a === nodeId) out.add(e.b);
        if (e.b === nodeId) out.add(e.a);
      }
    }
    return [...out];
  }

  nodeById(id: string) {
    return this.store.findWorkspaceOfNode(id)?.node;
  }

  bandOf(terminalId: string): PalcoNode<BandData> | undefined {
    for (const ws of this.store.workspaces.values()) {
      const b = ws.nodes.find((n) => n.type === 'band' && (n.data as BandData).members.includes(terminalId));
      if (b) return b as PalcoNode<BandData>;
    }
    return undefined;
  }

  /** Everything a terminal can address: direct ropes, its band, ropes of its band, chained notes. */
  reach(callerId: string): Reach {
    const agents = new Map<string, PalcoNode<TerminalData>>();
    const bands = new Map<string, PalcoNode<BandData>>();
    const portals = new Map<string, PalcoNode<PortalData>>();
    const notes = new Map<string, { node: PalcoNode<NoteData>; depth: number }>();

    const hubs = [callerId];
    const myBand = this.bandOf(callerId);
    if (myBand) {
      hubs.push(myBand.id);
      bands.set(myBand.id, myBand);
      for (const m of myBand.data.members) {
        const n = this.nodeById(m);
        if (n && m !== callerId) agents.set(m, n as PalcoNode<TerminalData>);
      }
    }
    const noteQueue: { id: string; depth: number }[] = [];
    for (const hub of hubs) {
      for (const id of this.neighbors(hub)) {
        const n = this.nodeById(id);
        if (!n || id === callerId) continue;
        if (n.type === 'terminal') agents.set(id, n as PalcoNode<TerminalData>);
        else if (n.type === 'portal') portals.set(id, n as PalcoNode<PortalData>);
        else if (n.type === 'note') noteQueue.push({ id, depth: 0 });
        else if (n.type === 'band') {
          const b = n as PalcoNode<BandData>;
          bands.set(id, b);
          for (const m of b.data.members) {
            const mn = this.nodeById(m);
            if (mn && m !== callerId) agents.set(m, mn as PalcoNode<TerminalData>);
          }
        }
      }
    }
    while (noteQueue.length) {
      const { id, depth } = noteQueue.shift()!;
      if (notes.has(id)) continue;
      const n = this.nodeById(id);
      if (!n || n.type !== 'note') continue;
      notes.set(id, { node: n as PalcoNode<NoteData>, depth });
      for (const nb of this.neighbors(id)) {
        const nn = this.nodeById(nb);
        if (nn?.type === 'note' && !notes.has(nb)) noteQueue.push({ id: nb, depth: depth + 1 });
      }
    }
    return { agents: [...agents.values()], bands: [...bands.values()], notes: [...notes.values()], portals: [...portals.values()] };
  }

  canReach(callerId: string | undefined, targetId: string) {
    if (!callerId) return true; // the human, through the UI, reaches everything
    const r = this.reach(callerId);
    return [...r.agents, ...r.bands, ...r.portals].some((n) => n.id === targetId) || r.notes.some((x) => x.node.id === targetId);
  }

  /** Resolve a name the caller is allowed to touch. */
  reachable(callerId: string | undefined, name: string, types: NodeType[]) {
    const ctx = callerId ? this.locate(callerId).ws : undefined;
    const hit = this.byName(name, ctx, types);
    if (callerId && hit.node.id === callerId) return hit;
    if (!this.canReach(callerId, hit.node.id)) {
      throw new PalcoError(`"${name}" não está conectado a você. Conecte com uma corda no canvas ou \`palco connect\`.`);
    }
    return hit;
  }

  // -------------------------------------------------------------- mutations
  freeSpot(ws: Workspace, floorId: string, near: PalcoNode | undefined, w: number, h: number, side: 'right' | 'left' = 'right') {
    let x = near ? (side === 'right' ? near.x + near.w + 80 : near.x - w - 80) : 0;
    let y = near ? near.y : 0;
    const overlaps = () => ws.nodes.some((n) => n.floorId === floorId && n.type !== 'drawing'
      && x < n.x + n.w + 30 && x + w + 30 > n.x && y < n.y + n.h + 30 && y + h + 30 > n.y);
    let guard = 0;
    while (overlaps() && guard++ < 200) y += 60;
    return { x, y };
  }

  addNode<T>(ws: Workspace, type: NodeType, data: T, opts: { floorId?: string; x?: number; y?: number; w?: number; h?: number; near?: PalcoNode; side?: 'left' | 'right' } = {}) {
    const [dw, dh] = SIZE[type];
    const w = opts.w ?? dw, h = opts.h ?? dh;
    const floorId = opts.floorId ?? opts.near?.floorId ?? this.groundOf(ws).id;
    const pos = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : this.freeSpot(ws, floorId, opts.near, w, h, opts.side);
    if (type !== 'drawing') (data as { name: string }).name = this.store.uniqueNodeName(ws, (data as { name: string }).name);
    const node: PalcoNode<T> = { id: uid(), type, floorId, x: pos.x, y: pos.y, w, h, data, createdAt: now() };
    ws.nodes.push(node as PalcoNode);
    if (type === 'terminal') {
      const floor = ws.floors.find((f) => f.id === floorId);
      if (!floor?.unloaded && !ws.unloaded) this.sessions.start(ws, node as PalcoNode);
    }
    this.store.touch(ws);
    return node;
  }

  newTerminalData(ws: Workspace, opts: { name?: string; preset?: Preset; command?: string; cwd?: string; floorId?: string; roleId?: string; color?: string; icon?: string }): TerminalData {
    const preset = opts.preset;
    const floor = ws.floors.find((f) => f.id === opts.floorId) ?? this.groundOf(ws);
    return {
      name: opts.name || preset?.name || 'Terminal',
      command: opts.command ?? preset?.command ?? '',
      cwd: opts.cwd || floor.dir || ws.dir,
      agentType: opts.command !== undefined && !preset ? guessAgentType(opts.command) : preset?.agentType ?? 'shell',
      presetId: preset?.id,
      roleId: opts.roleId,
      color: opts.color || preset?.color || randomColor(),
      icon: opts.icon,
      chat: preset?.chat ?? false,
      maestro: preset?.maestro ?? false,
    };
  }

  updateNode(ws: Workspace, nodeId: string, patch: Partial<Pick<PalcoNode, 'x' | 'y' | 'w' | 'h' | 'floorId'>> & { data?: Record<string, unknown> }) {
    const node = ws.nodes.find((n) => n.id === nodeId);
    if (!node) throw new PalcoError('Nó não encontrado');
    const { data, ...geo } = patch;
    Object.assign(node, geo);
    if (data) {
      if (typeof data.name === 'string') data.name = this.store.uniqueNodeName(ws, data.name, node.id);
      Object.assign(node.data as object, data);
    }
    this.store.touch(ws);
    return node;
  }

  removeNode(ws: Workspace, nodeId: string) {
    const node = ws.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    ws.nodes = ws.nodes.filter((n) => n.id !== nodeId);
    for (const w of this.store.workspaces.values()) {
      const before = w.edges.length;
      w.edges = w.edges.filter((e) => e.a !== nodeId && e.b !== nodeId);
      for (const b of w.nodes) {
        if (b.type === 'band') (b.data as BandData).members = (b.data as BandData).members.filter((m) => m !== nodeId);
      }
      if (w !== ws && before !== w.edges.length) this.store.touch(w);
    }
    if (node.type === 'terminal') this.sessions.stop(nodeId, true);
    if (node.type === 'note') this.store.deleteNoteFile(ws.id, nodeId);
    if (node.type === 'portal') this.portalHook?.close(nodeId);
    // bands with fewer than two members dissolve on their own
    for (const b of ws.nodes.filter((n) => n.type === 'band')) {
      if ((b.data as BandData).members.length < 2 && node.type === 'terminal') this.removeNode(ws, b.id);
    }
    this.store.touch(ws);
  }

  connect(ws: Workspace, a: string, b: string): Edge {
    if (a === b) throw new PalcoError('Não dá para conectar um nó a ele mesmo.');
    const na = this.nodeById(a), nb = this.nodeById(b);
    if (!na || !nb) throw new PalcoError('Nó não encontrado');
    const types = new Set([na.type, nb.type]);
    if (types.has('drawing')) throw new PalcoError('Desenhos não recebem cordas.');
    if (types.has('portal') && types.has('note')) throw new PalcoError('Notas não se conectam a portais.');
    if (na.type === 'portal' && nb.type === 'portal') throw new PalcoError('Dois portais não se conectam por corda.');
    const sameFloor = na.floorId === nb.floorId;
    if (!sameFloor && !(na.type === 'terminal' && nb.type === 'terminal') && !(types.has('band') && types.has('terminal'))) {
      throw new PalcoError('Cordas de notas e portais ficam no mesmo andar; só agentes se ligam entre andares.');
    }
    const existing = this.findEdge(a, b);
    if (existing) return existing;
    const edge: Edge = { id: uid(), a, b, createdAt: now() };
    ws.edges.push(edge);
    this.store.touch(ws);
    return edge;
  }

  findEdge(a: string, b: string) {
    for (const ws of this.store.workspaces.values()) {
      const e = ws.edges.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (e) return e;
    }
    return undefined;
  }

  disconnect(edgeId: string) {
    for (const ws of this.store.workspaces.values()) {
      const n = ws.edges.length;
      ws.edges = ws.edges.filter((e) => e.id !== edgeId);
      if (ws.edges.length !== n) this.store.touch(ws);
    }
  }

  // ------------------------------------------------------------- messaging
  session(nodeId: string): Session {
    const s = this.sessions.get(nodeId);
    if (s && !s.exited) return s;
    const { ws, node } = this.locate(nodeId);
    if (node.type !== 'terminal') throw new PalcoError(`${nameOf(node)} não é um terminal.`);
    // wake an unloaded floor / workspace terminal on demand
    const floor = ws.floors.find((f) => f.id === node.floorId);
    if (floor) floor.unloaded = false;
    ws.unloaded = false;
    this.store.touch(ws);
    return this.sessions.start(ws, node);
  }

  /**
   * Resolves once the terminal has produced output after `seqBefore` and then gone quiet.
   * `seqBefore` must be read before writing to the terminal: a fast shell can answer
   * within the same millisecond, so timestamps alone miss the reply.
   */
  waitIdle(s: Session, timeoutMs: number, minQuietAfterStart = true, seqBefore = s.outputSeq): Promise<'idle' | 'timeout'> {
    return new Promise((resolve) => {
      const started = Date.now();
      const iv = setInterval(() => {
        const t = Date.now();
        const quiet = t - s.lastOutputAt >= this.sessions.idleMs;
        const sawOutputSince = s.outputSeq > seqBefore;
        if ((quiet && (sawOutputSince || !minQuietAfterStart) && t - started > 800) || s.exited) {
          clearInterval(iv);
          resolve('idle');
        } else if (t - started > timeoutMs) {
          clearInterval(iv);
          resolve('timeout');
        }
      }, 200);
    });
  }

  /**
   * Send a prompt to an agent and wait for it to finish (output goes quiet) or for it to
   * answer back with `palco ask "<caller>" ...`, whichever comes first.
   */
  async ask(callerId: string | undefined, targetName: string, text: string, opts: { raw?: boolean; timeoutMs?: number; fromUser?: boolean } = {}): Promise<string> {
    const { ws, node } = this.reachable(callerId, targetName, ['terminal', 'band']);
    if (node.type === 'band') throw new PalcoError('Para falar com uma band, pergunte a um membro dela.');
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

    // Ask-back: the target is waiting on *us* -> resolve its pending ask with this message.
    if (callerId) {
      const idx = this.waiters.findIndex((w) => w.from === node.id && w.to === callerId);
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        const caller = this.nodeById(callerId)!;
        w.resolve(`Resposta de ${this.displayName(caller, ws)}:\n${text}`);
        this.logChat(node.id, 'peer', text, nameOf(caller));
        return `Entregue a ${this.displayName(node)} (resposta à pergunta que estava esperando).`;
      }
    }

    const s = this.session(node.id);
    if (opts.raw) {
      s.write(decodeRaw(text));
      await new Promise((r) => setTimeout(r, 600));
      return s.screen();
    }
    if (s.status === 'starting') await this.waitIdle(s, 20_000, false);

    const caller = callerId ? this.nodeById(callerId) : undefined;
    const isShell = (node.data as TerminalData).agentType === 'shell';
    const header = caller && !isShell
      ? `[Palco] Mensagem de "${this.displayName(caller, ws)}". Se for uma tarefa, ao terminar responda com: palco ask "${this.displayName(caller, ws)}" "<resultado>"\n\n`
      : '';
    this.logChat(node.id, caller ? 'peer' : 'user', text, caller ? nameOf(caller) : undefined);
    const seqBefore = s.outputSeq;
    typePrompt(s, header + text, !isShell);

    return new Promise<string>((resolve) => {
      let done = false;
      const finish = (out: string) => {
        if (done) return;
        done = true;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(out);
      };
      const waiter: Waiter = { from: callerId ?? '__user__', to: node.id, resolve: finish };
      if (callerId) this.waiters.push(waiter);
      this.waitIdle(s, timeoutMs, true, seqBefore).then((r) => {
        if (r === 'timeout') {
          finish(`⏱  Tempo esgotado esperando ${nameOf(node)}. Não reenvie: use \`palco check "${nameOf(node)}"\` e espere de novo. Se pediu "ask back", a resposta chega como nova mensagem.\n\n${s.screen()}`);
        } else {
          finish(s.screen());
        }
      });
    });
  }

  logChat(nodeId: string, from: 'user' | 'peer' | 'agent' | 'system', text: string, name?: string) {
    const hit = this.store.findWorkspaceOfNode(nodeId);
    if (hit) this.store.appendChat(hit.ws.id, nodeId, { from, text, name });
  }

  /** The human talking to an agent from the chat face of a terminal. */
  chatSend(nodeId: string, text: string, attachments: string[] = []) {
    const s = this.session(nodeId);
    this.store.appendChat(this.locate(nodeId).ws.id, nodeId, { from: 'user', text, attachments });
    const files = attachments.length ? `\n\nArquivos anexados:\n${attachments.map((a) => `- ${a}`).join('\n')}` : '';
    const shell = (this.locate(nodeId).node.data as TerminalData).agentType === 'shell';
    if (shell) return typePrompt(s, text, false);
    typePrompt(s, `---\nMensagem do usuário pelo Palco Chat. Responda somente com \`palco say\` (a skill palco explica).\n---\n${text}${files}`);
  }

  notify(text: string, title = 'Palco') {
    this.emit('notify', { title, text });
    if (process.platform === 'darwin' && this.store.config.settings.notifications) {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFile('osascript', ['-e', `display notification "${esc(text)}" with title "${esc(title)}"`], () => {});
    }
  }
}

export function guessAgentType(command: string): TerminalData['agentType'] {
  const prog = command.trim().split(/\s+/).find((t) => !t.includes('='))?.split('/').pop() ?? '';
  if (!prog) return 'shell';
  if (prog === 'claude') return 'claude_code';
  if (prog === 'codex') return 'codex';
  if (prog === 'opencode') return 'opencode';
  if (prog === 'gemini') return 'gemini';
  return 'custom';
}
