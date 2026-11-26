import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Store, uid } from './store.js';
import { SessionManager, typePrompt } from './sessions.js';
import { Core, PalcoError } from './core.js';
import { Floors } from './floors.js';
import { Routines } from './routines.js';
import { Portals } from './portals.js';
import { Commands } from './commands.js';
import { importMaestri } from './importer.js';
import { CLI_BIN_DIR, PALCO_HOME, PKG_ROOT, WEB_DIR } from './paths.js';
import type { BandData, NoteData, PalcoNode, PortalData, Preset, Role, Routine, TerminalData } from './types.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version as string;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const hostnameOf = (hostHeader?: string) => {
  if (!hostHeader) return '';
  try { return new URL(`http://${hostHeader}`).hostname; } catch { return ''; }
};

/** Blocks DNS rebinding and cross-site requests: only loopback Host and Origin are accepted. */
export function originAllowed(req: http.IncomingMessage) {
  if (!LOOPBACK.has(hostnameOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return LOOPBACK.has(new URL(origin).hostname); } catch { return false; }
}

function tokenOk(provided: string | undefined, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function writeCliShim() {
  fs.mkdirSync(CLI_BIN_DIR, { recursive: true });
  const cli = fs.existsSync(path.join(PKG_ROOT, 'dist', 'cli', 'palco.js'))
    ? `exec "${process.execPath}" "${path.join(PKG_ROOT, 'dist', 'cli', 'palco.js')}" "$@"`
    : `exec "${path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx')}" "${path.join(PKG_ROOT, 'cli', 'palco.ts')}" "$@"`;
  const shim = path.join(CLI_BIN_DIR, 'palco');
  fs.writeFileSync(shim, `#!/bin/sh\n${cli}\n`, { mode: 0o755 });
}

async function readBody(req: http.IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new PalcoError('Corpo da requisição grande demais.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface Server {
  url: string;
  port: number;
  store: Store;
  core: Core;
  close(): Promise<void>;
}

export async function startServer(opts: { port?: number } = {}): Promise<Server> {
  const store = new Store();
  store.load();
  const port = opts.port ?? Number(process.env.PALCO_PORT || store.config.port || 4747);
  const url = `http://127.0.0.1:${port}`;
  writeCliShim();

  const sessions = new SessionManager(store, () => url);
  const core = new Core(store, sessions);
  const floors = new Floors(core);
  const routines = new Routines(core);
  const portals = new Portals(core);
  const commands = new Commands(core, floors, routines, portals);

  // boot terminals of loaded workspaces/floors
  for (const ws of store.orderedWorkspaces()) {
    if (ws.unloaded) continue;
    for (const n of ws.nodes) {
      const floor = ws.floors.find((f) => f.id === n.floorId);
      if (n.type === 'terminal' && !floor?.unloaded) sessions.start(ws, n);
    }
  }
  routines.startAll();

  // ------------------------------------------------------------- websocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const clients = new Set<WebSocket & { watching?: Set<string> }>();
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
  };

  store.on('workspace', (ws) => broadcast({ t: 'workspace', ws }));
  store.on('workspace-deleted', (id) => broadcast({ t: 'workspace-deleted', id }));
  store.on('config', () => broadcast({ t: 'config', config: publicConfig() }));
  store.on('note', (wsId, nodeId, content) => broadcast({ t: 'note', wsId, nodeId, content }));
  store.on('chat', (wsId, nodeId, entry) => broadcast({ t: 'chat', wsId, nodeId, entry }));
  sessions.on('data', (_ws, id, data) => broadcast({ t: 'out', id, data }));
  sessions.on('status', (_ws, id, status) => broadcast({ t: 'status', id, status }));
  core.on('notify', (n) => broadcast({ t: 'notify', ...n }));
  portals.on('frame', (id: string, data: string) => {
    const s = JSON.stringify({ t: 'frame', id, data });
    for (const c of clients) if (c.watching?.has(id) && c.readyState === c.OPEN && c.bufferedAmount < 4_000_000) c.send(s);
  });

  const publicConfig = () => {
    const { token: _t, ...rest } = store.config;
    void _t;
    return rest;
  };

  wss.on('connection', (ws: WebSocket & { watching?: Set<string> }) => {
    clients.add(ws);
    ws.watching = new Set();
    const statuses = Object.fromEntries([...sessions.sessions.values()].map((s) => [s.nodeId, s.status]));
    ws.send(JSON.stringify({ t: 'hello', version: VERSION, config: publicConfig(), workspaces: store.orderedWorkspaces(), statuses, home: process.env.HOME }));
    ws.on('message', (raw) => {
      let m: { t: string; id?: string; data?: string; cols?: number; rows?: number; ev?: unknown; width?: number; height?: number };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const id = m.id ?? '';
      if (m.t === 'input') sessions.get(id)?.write(String(m.data ?? ''));
      else if (m.t === 'resize') sessions.get(id)?.resize(Number(m.cols), Number(m.rows));
      else if (m.t === 'attach') {
        const s = sessions.get(id);
        ws.send(JSON.stringify({ t: 'replay', id, data: s?.replay ?? '', status: s?.status ?? 'exited' }));
      } else if (m.t === 'watch') {
        ws.watching!.add(id);
        portals.watch(id).catch((e) => ws.send(JSON.stringify({ t: 'portal-error', id, error: (e as Error).message })));
      } else if (m.t === 'unwatch') {
        if (ws.watching!.delete(id)) void portals.unwatch(id);
      } else if (m.t === 'portal-input') {
        portals.input(id, m.ev as never).catch(() => {});
      } else if (m.t === 'portal-viewport') {
        portals.setViewport(id, Number(m.width), Number(m.height)).then(() => store.touch(core.locate(id).ws)).catch(() => {});
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      for (const id of ws.watching ?? []) void portals.unwatch(id);
    });
  });

  // ------------------------------------------------------------------ ops
  const ops: Record<string, (b: Record<string, any>) => unknown> = {
    'ws.create': (b) => store.createWorkspace(String(b.name || 'Workspace'), String(b.dir || process.env.HOME)),
    'ws.rename': (b) => { const w = core.ws(b.wsId); w.name = store.uniqueWorkspaceName(String(b.name)); store.touch(w); return w; },
    'ws.setDir': (b) => { const w = core.ws(b.wsId); return floors.setDir(w, core.groundOf(w).name, String(b.dir)); },
    'ws.delete': (b) => {
      const w = core.ws(b.wsId);
      for (const n of w.nodes) if (n.type === 'terminal') sessions.stop(n.id, true); else if (n.type === 'portal') void portals.close(n.id);
      for (const r of w.routines) routines.unschedule(r.id);
      store.deleteWorkspace(w.id);
      if (store.workspaces.size === 0) store.createWorkspace('Meu Workspace', process.env.HOME || '/');
      return true;
    },
    'ws.reorder': (b) => { store.config.workspaceOrder = (b.order as string[]).filter((id) => store.workspaces.has(id)); store.saveConfig(); return true; },
    'ws.open': (b) => {
      const w = core.ws(b.wsId);
      w.lastOpenedAt = new Date().toISOString();
      if (w.unloaded) {
        w.unloaded = false;
        for (const n of w.nodes) if (n.type === 'terminal' && !sessions.get(n.id) && !w.floors.find((f) => f.id === n.floorId)?.unloaded) sessions.start(w, n);
      }
      store.touch(w);
      return true;
    },
    'ws.viewport': (b) => { const w = core.ws(b.wsId); w.viewport[b.floorId] = b.viewport; store.flush(w.id); return true; },
    'node.add': (b) => {
      const w = core.ws(b.wsId);
      const type = b.type as PalcoNode['type'];
      let data = b.data ?? {};
      if (type === 'terminal') {
        const preset = store.config.presets.find((p) => p.id === b.presetId);
        data = core.newTerminalData(w, { preset, floorId: b.floorId, name: data.name, command: data.command, cwd: data.cwd, roleId: data.roleId });
      } else if (type === 'note') data = { name: 'Nota', color: 'yellow', locked: false, preview: false, ...data } satisfies NoteData;
      else if (type === 'portal') data = { name: 'Portal', url: '', viewport: { width: 1280, height: 800 }, ...data } satisfies PortalData;
      else if (type === 'band') data = { name: 'Band', members: [], color: '#9a8cf0', ...data } satisfies BandData;
      const node = core.addNode(w, type, data, { floorId: b.floorId, x: b.x, y: b.y, w: b.w, h: b.h });
      if (type === 'note' && typeof b.content === 'string') store.writeNote(w.id, node.id, b.content);
      return node;
    },
    'node.update': (b) => core.updateNode(core.ws(b.wsId), b.nodeId, b.patch ?? {}),
    'node.updateMany': (b) => {
      const w = core.ws(b.wsId);
      for (const it of b.items as { nodeId: string; patch: Record<string, number> }[]) {
        const n = w.nodes.find((x) => x.id === it.nodeId);
        if (n) Object.assign(n, it.patch);
      }
      store.touch(w);
      return true;
    },
    'node.remove': (b) => { const w = core.ws(b.wsId); for (const id of [].concat(b.nodeId)) core.removeNode(w, id); return true; },
    'node.restart': (b) => { const { ws: w, node } = core.locate(b.nodeId); sessions.start(w, node); return true; },
    'node.interrupt': (b) => { sessions.get(b.nodeId)?.write('\x03'); return true; },
    'edge.add': (b) => core.connect(core.ws(b.wsId), b.a, b.b),
    'edge.remove': (b) => { core.disconnect(b.edgeId); return true; },
    'band.create': (b) => {
      const w = core.ws(b.wsId);
      const members = (b.members as string[]).filter((m) => !core.bandOf(m));
      if (members.length < 2) throw new PalcoError('Selecione pelo menos dois terminais fora de outra band.');
      const near = w.nodes.find((n) => n.id === members[0]);
      return core.addNode<BandData>(w, 'band', { name: b.name || 'Band', members, color: '#9a8cf0' }, { floorId: near?.floorId, near, side: 'left' });
    },
    'band.setMembers': (b) => {
      const w = core.ws(b.wsId);
      const band = w.nodes.find((n) => n.id === b.bandId && n.type === 'band');
      if (!band) throw new PalcoError('Band não encontrada');
      (band.data as BandData).members = b.members;
      store.touch(w);
      return band;
    },
    'note.write': (b) => { store.writeNote(b.wsId, b.nodeId, String(b.content ?? '')); return true; },
    'floor.create': (b) => floors.create(core.ws(b.wsId), String(b.name), b.opts ?? {}),
    'floor.remove': (b) => floors.remove(core.ws(b.wsId), String(b.name), b.opts ?? {}),
    'floor.land': (b) => floors.land(core.ws(b.wsId), String(b.name), b.opts ?? {}),
    'floor.load': (b) => { floors.load(core.ws(b.wsId), b.floorId); return true; },
    'floor.unload': (b) => floors.unload(core.ws(b.wsId), String(b.name)),
    'floor.rename': (b) => { const w = core.ws(b.wsId); const f = w.floors.find((x) => x.id === b.floorId); if (f) f.name = String(b.name); store.touch(w); return true; },
    'routine.create': (b) => routines.create(core.ws(b.wsId), b.routine as Omit<Routine, 'id'>),
    'routine.update': (b) => routines.update(core.ws(b.wsId), b.name, b.patch),
    'routine.remove': (b) => { routines.remove(core.ws(b.wsId), b.name); return true; },
    'routine.run': (b) => { const w = core.ws(b.wsId); return routines.run(w.id, routines.find(w, b.name).id, true); },
    'routine.next': (b) => Object.fromEntries(core.ws(b.wsId).routines.map((r) => [r.id, routines.nextRun(r)])),
    'role.save': (b) => {
      const r = b.role as Role;
      const w = b.wsId ? core.ws(b.wsId) : undefined;
      for (const list of [store.config.roles, ...(w ? [w.roles] : [])]) {
        const i = list.findIndex((x) => x.id === r.id);
        if (i >= 0) list.splice(i, 1);
      }
      const role = { ...r, id: r.id || uid() };
      if (role.scope === 'global' || !w) store.config.roles.push({ ...role, scope: 'global' });
      else w.roles.push(role);
      store.saveConfig();
      if (w) store.touch(w);
      return role;
    },
    'role.remove': (b) => {
      store.config.roles = store.config.roles.filter((x) => x.id !== b.id);
      for (const w of store.workspaces.values()) { const n = w.roles.length; w.roles = w.roles.filter((x) => x.id !== b.id); if (n !== w.roles.length) store.touch(w); }
      store.saveConfig();
      return true;
    },
    'preset.save': (b) => {
      const p = b.preset as Preset;
      const i = store.config.presets.findIndex((x) => x.id === p.id);
      const full: Preset = { ...p, id: p.id || uid(), agentType: p.agentType || 'custom' };
      if (i >= 0) store.config.presets[i] = full; else store.config.presets.push(full);
      store.saveConfig();
      return full;
    },
    'preset.remove': (b) => { store.config.presets = store.config.presets.filter((x) => x.id !== b.id); store.saveConfig(); return true; },
    'partitura.delete': (b) => { store.config.partituras = store.config.partituras.filter((x) => x.id !== b.id); store.saveConfig(); return true; },
    'partitura.insert': (b) => {
      const w = core.ws(b.wsId);
      const floor = w.floors.find((f) => f.id === b.floorId);
      return commands.partitura({ pos: ['insert', b.name], flags: floor ? { floor: floor.name } : {} }, {});
    },
    'settings.update': (b) => { Object.assign(store.config.settings, b.settings); store.saveConfig(); return store.config.settings; },
    'chat.send': (b) => { core.chatSend(b.nodeId, String(b.text ?? ''), b.attachments ?? []); return true; },
    'chat.read': (b) => { const { ws: w } = core.locate(b.nodeId); return store.readChat(w.id, b.nodeId); },
    'note.read': (b) => store.readNote(b.wsId, b.nodeId),
    'notes.readAll': (b) => {
      const w = core.ws(b.wsId);
      return Object.fromEntries(w.nodes.filter((n) => n.type === 'note').map((n) => [n.id, store.readNote(w.id, n.id)]));
    },
    'term.screen': (b) => sessions.get(b.nodeId)?.tail(Number(b.lines) || 200) ?? '',
    'import.maestri': () => importMaestri(core),
    'compose.send': async (b) => {
      // The human's composer: deliver one prompt to several terminals at once.
      const results: string[] = [];
      for (const id of b.targets as string[]) {
        const node = core.nodeById(id);
        if (!node || node.type !== 'terminal') continue;
        const s = core.session(id);
        const d = node.data as TerminalData;
        if (d.chat) core.chatSend(id, String(b.text), b.attachments ?? []);
        else {
          const files = (b.attachments as string[] | undefined)?.length ? `\n\n${(b.attachments as string[]).join('\n')}` : '';
          typePrompt(s, `${b.text}${files}`, d.agentType !== 'shell');
          core.logChat(id, 'user', String(b.text));
        }
        results.push(id);
      }
      return results;
    },
  };

  // ----------------------------------------------------------------- http
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', url);
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body as string);
    };
    if (!originAllowed(req)) return send(403, { error: 'origem não permitida' });

    if (u.pathname.startsWith('/api/')) {
      if (u.pathname === '/api/health') return send(200, { ok: true, version: VERSION, pid: process.pid, home: PALCO_HOME });
      // <img> tags cannot send headers, so /api/file also accepts ?token=
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '')
        ?? (u.pathname === '/api/file' ? u.searchParams.get('token') ?? undefined : undefined);
      if (!tokenOk(auth, store.config.token)) return send(401, { error: 'token inválido; abra o Palco pelo comando `palco`' });
      try {
        if (u.pathname === '/api/cli' && req.method === 'POST') {
          const body = JSON.parse(String(await readBody(req)) || '{}');
          try {
            const out = await commands.run(body.argv ?? [], { callerId: body.callerId || undefined, stdin: body.stdin });
            return send(200, { out, code: 0 });
          } catch (e) {
            return send(200, { out: (e as Error).message, code: e instanceof PalcoError ? e.code : 1 });
          }
        }
        if (u.pathname === '/api/op' && req.method === 'POST') {
          const body = JSON.parse(String(await readBody(req)) || '{}');
          const fn = ops[body.op];
          if (!fn) return send(404, { error: `op desconhecida: ${body.op}` });
          return send(200, { result: await fn(body) });
        }
        if (u.pathname === '/api/upload' && req.method === 'POST') {
          const buf = await readBody(req);
          const ext = (u.searchParams.get('ext') || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
          const dir = path.join(PALCO_HOME, 'uploads');
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `${Date.now()}-${uid().slice(0, 8)}.${ext}`);
          fs.writeFileSync(f, buf);
          return send(200, { path: f });
        }
        if (u.pathname === '/api/file' && req.method === 'GET') {
          // Serves chat attachments; only from Palco's own folders.
          const f = path.resolve(u.searchParams.get('path') || '');
          const allowed = [path.join(PALCO_HOME, 'uploads'), path.join(PALCO_HOME, 'screenshots')];
          const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f);
          if (!isImage && !allowed.some((d) => f.startsWith(d + path.sep))) return send(403, { error: 'arquivo fora das pastas do Palco' });
          if (!fs.existsSync(f)) return send(404, { error: 'não encontrado' });
          res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
          return fs.createReadStream(f).pipe(res);
        }
        return send(404, { error: 'rota desconhecida' });
      } catch (e) {
        const status = e instanceof PalcoError ? 400 : 500;
        if (status === 500) console.error('[api]', e);
        return send(status, { error: (e as Error).message });
      }
    }

    // static web app
    let file = path.join(WEB_DIR, decodeURIComponent(u.pathname));
    if (!file.startsWith(WEB_DIR)) return send(403, 'forbidden', 'text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
    if (!fs.existsSync(file)) return send(503, 'Interface não compilada. Rode: npm run build', 'text/plain; charset=utf-8');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    fs.createReadStream(file).pipe(res);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', url);
    if (u.pathname !== '/ws' || !originAllowed(req) || !tokenOk(u.searchParams.get('token') ?? undefined, store.config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const close = async () => {
    routines.stopAll();
    store.flushAll();
    for (const s of sessions.sessions.values()) sessions.persistScrollback(s);
    sessions.stopAll();
    await portals.shutdown();
    for (const c of clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { url, port, store, core, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(path.join('server', 'index.js'));
if (isMain) {
  startServer().then((srv) => {
    console.log(`[palco] ${VERSION} ouvindo em ${srv.url} (dados em ${PALCO_HOME})`);
    let closing = false;
    const shutdown = (sig: string) => {
      if (closing) return;
      closing = true;
      console.log(`[palco] ${sig}: salvando e encerrando`);
      srv.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error('[palco] porta em uso — já existe um Palco rodando? Use `palco status`.');
    else console.error('[palco] falha ao iniciar:', err);
    process.exit(1);
  });
}
