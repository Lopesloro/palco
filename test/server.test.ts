import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-test-'));
process.env.PALCO_HOME = HOME;
process.env.SHELL = '/bin/sh';
const PORT = 47000 + Math.floor(Math.random() * 1000);

type Srv = Awaited<ReturnType<typeof import('../server/index.js')['startServer']>>;
let srv: Srv;
let token = '';
let wsId = '';
let floorId = '';

async function op<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${srv.url}/api/op`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: name, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.result as T;
}

async function cli(callerId: string | undefined, ...argv: string[]) {
  const r = await fetch(`${srv.url}/api/cli`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv, callerId }),
  });
  return (await r.json()) as { out: string; code: number };
}

function rawRequest(headers: Record<string, string>, pathName = '/api/health'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: pathName, headers, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

beforeAll(async () => {
  const { startServer } = await import('../server/index.js');
  srv = await startServer({ port: PORT });
  token = srv.store.config.token;
  srv.store.config.settings.idleMs = 700;
  const ws = srv.store.orderedWorkspaces()[0];
  wsId = ws.id;
  floorId = ws.floors[0].id;
});

afterAll(async () => {
  await srv?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('security', () => {
  it('rejects API calls without the token', async () => {
    const r = await fetch(`${srv.url}/api/op`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    expect(await rawRequest({ Host: 'evil.example.com' })).toBe(403);
  });

  it('rejects cross-site Origin', async () => {
    expect(await rawRequest({ Host: `127.0.0.1:${srv.port}`, Origin: 'https://evil.example.com' })).toBe(403);
    expect(await rawRequest({ Host: `127.0.0.1:${srv.port}`, Origin: `http://localhost:${srv.port}` })).toBe(200);
  });

  it('survives a malformed URL escape instead of crashing', async () => {
    expect(await rawRequest({ Host: `127.0.0.1:${srv.port}` }, '/%E0%A4%A')).toBe(400);
    expect((await fetch(`${srv.url}/api/health`)).status).toBe(200);
  });

  it('keeps the config private', () => {
    const mode = fs.statSync(path.join(HOME, 'config.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('agents', () => {
  let alpha = '';
  let beta = '';
  let gamma = '';

  beforeAll(async () => {
    const mk = async (name: string, x: number) => (await op('node.add', { wsId, type: 'terminal', floorId, x, y: 0, data: { name, command: '' } })).id as string;
    alpha = await mk('Alpha', 0);
    beta = await mk('Beta', 800);
    gamma = await mk('Gamma', 1600);
    await op('edge.add', { wsId, a: alpha, b: beta });
    await until(() => srv.core.sessions.get(beta)?.status === 'idle', 10000);
  });

  it('lists only connected agents', async () => {
    const r = await cli(alpha, 'list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('You: Alpha');
    expect(r.out).toContain('Beta');
    expect(r.out).not.toContain('Gamma');
  });

  it('refuses to ask an agent that is not connected', async () => {
    const r = await cli(alpha, 'ask', 'Gamma', 'echo oi');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/não está conectado/);
  });

  it('asks a connected agent and returns its screen when it goes idle', async () => {
    const r = await cli(alpha, 'ask', 'Beta', 'echo palco-$((40+2))');
    expect(r.code).toBe(0);
    expect(r.out).toContain('palco-42');
  });

  it('check reads the screen without sending anything', async () => {
    const r = await cli(alpha, 'check', 'Beta');
    expect(r.out).toContain('palco-42');
  });

  it('raw input decodes escapes', async () => {
    await cli(alpha, 'ask', 'Beta', '--raw', 'echo raw-ok\\n');
    expect(await until(async () => (await cli(alpha, 'check', 'Beta')).out.includes('raw-ok'))).toBe(true);
  });

  it('ask back resolves the pending ask in full', async () => {
    // Beta is a shell: the prompt we "ask" makes Beta itself call palco ask back to Alpha.
    const pending = cli(alpha, 'ask', 'Beta', `palco ask "Alpha" "resultado-final"`);
    const r = await pending;
    expect(r.out).toContain('Resposta de Beta:\nresultado-final');
  });

  it('batch asks run in parallel and return JSON', async () => {
    await op('edge.add', { wsId, a: alpha, b: gamma });
    const r = await cli(alpha, 'ask', '--batch', JSON.stringify({ Beta: 'echo b-$((1+1))', Gamma: 'echo g-$((2+2))' }));
    const arr = JSON.parse(r.out) as { name: string; output: string }[];
    expect(arr.find((x) => x.name === 'Beta')?.output).toContain('b-2');
    expect(arr.find((x) => x.name === 'Gamma')?.output).toContain('g-4');
  });

  it('notes: create, read with lines, edit, lock', async () => {
    const c = await cli(alpha, 'note', 'create', '# Plano\nlinha dois', '--name', 'Plano', '--stack', 'Sprint');
    expect((await cli(alpha, 'list')).out).toContain('fichário: Sprint');
    expect(c.out).toContain('"Plano"');
    const read = await cli(alpha, 'note', 'read', 'Plano');
    expect(read.out).toMatch(/1\s+# Plano/);
    expect(read.out).toMatch(/2\s+linha dois/);
    expect((await cli(alpha, 'note', 'edit', 'Plano', 'linha dois', 'linha 2')).code).toBe(0);
    expect((await cli(alpha, 'note', 'read', 'Plano', '2', '1')).out).toMatch(/2\s+linha 2/);
    const ws = srv.store.workspaces.get(wsId)!;
    const note = ws.nodes.find((n) => n.type === 'note')!;
    await op('node.update', { wsId, nodeId: note.id, patch: { data: { locked: true } } });
    expect((await cli(alpha, 'note', 'write', 'Plano', 'x')).out).toMatch(/trancada/);
    // Beta is not connected to the note
    expect((await cli(beta, 'note', 'read', 'Plano')).code).toBe(1);
  });

  it('recruit spawns a connected terminal, dismiss removes it', async () => {
    const r = await cli(alpha, 'recruit', 'Coruja', '--command', '');
    expect(r.out).toContain('Coruja');
    expect((await cli(alpha, 'list')).out).toContain('Coruja');
    expect((await cli(alpha, 'dismiss', 'Coruja')).out).toContain('dispensado');
    expect((await cli(alpha, 'list')).out).not.toContain('Coruja');
  });

  it('bands connect every member to each other', async () => {
    const r = await cli(alpha, 'band', 'create', 'Trio');
    expect(r.code).toBe(0);
    // Beta and Gamma were never roped together, but the band links them
    expect((await cli(beta, 'list')).out).toContain('Gamma');
    expect((await cli(alpha, 'band', 'dissolve', 'Trio')).code).toBe(0);
    expect((await cli(beta, 'list')).out).not.toContain('Gamma');
  });

  it('roles: create, list, assign', async () => {
    expect((await cli(alpha, 'role', 'create', 'Revisor', 'Revise com cuidado.', '--scope', 'global')).code).toBe(0);
    expect((await cli(alpha, 'role', 'list')).out).toContain('Revisor');
    expect((await cli(alpha, 'role', 'assign', 'Beta', 'Revisor')).out).toContain('Revisor');
  });

  it('routines: create, run, delete', async () => {
    await until(() => srv.core.sessions.get(beta)?.status === 'idle', 10000);
    const c = await cli(alpha, 'routine', 'create', 'Pulso', '--command', 'echo pulso-ok', '--every', '1h', '--target', 'Beta');
    expect(c.code).toBe(0);
    expect((await cli(alpha, 'routine', 'run', 'Pulso')).out).toContain('Beta');
    expect(await until(async () => (await cli(alpha, 'check', 'Beta')).out.includes('pulso-ok'))).toBe(true);
    expect((await cli(alpha, 'routine', 'delete', 'Pulso')).code).toBe(0);
  });

  it('refuses to type into a menu that only the human may answer', async () => {
    const r0 = await cli(alpha, 'recruit', 'Menu', '--command', '');
    expect(r0.code).toBe(0);
    await until(() => [...srv.core.sessions.sessions.values()].some((s) => s.status === 'idle'), 10000);
    const menu = srv.core.byName('Menu').node.id;
    await until(() => srv.core.sessions.get(menu)?.status === 'idle', 10000);
    srv.core.sessions.get(menu)!.write(`printf '› 1. Update now\\n  2. Skip\\nPress enter to continue\\n'; read x\r`);
    expect(await until(() => srv.core.sessions.get(menu)?.status === 'attention', 10000)).toBe(true);
    const r = await cli(alpha, 'ask', 'Menu', 'echo nao-deveria-rodar');
    expect(r.code).toBe(3);
    await expect(op('compose.send', { targets: [menu], text: 'echo via-compositor' })).rejects.toThrow(/esperando você/);
    await expect(op('chat.send', { nodeId: menu, text: 'echo via-chat' })).rejects.toThrow(/esperando você/);
    expect(r.out).toMatch(/esperando o usuário/);
    const after = (await cli(alpha, 'check', 'Menu')).out;
    expect(after).not.toContain('nao-deveria-rodar');
    expect(after).not.toContain('via-compositor');
    expect(after).not.toContain('via-chat');
    await cli(alpha, 'dismiss', 'Menu');
  });

  it('identifies agents by their own terminal token, which only opens the CLI', async () => {
    const betaToken = srv.core.sessions.get(beta)!.token;
    expect(betaToken).not.toBe(token);
    const post = (pathName: string, body: unknown) => fetch(`${srv.url}${pathName}`, {
      method: 'POST', headers: { Authorization: `Bearer ${betaToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    // claiming to be Alpha does not work: the token says Beta
    const r = await (await post('/api/cli', { argv: ['list'], callerId: alpha })).json();
    expect(r.out).toContain('You: Beta');
    expect((await post('/api/op', { op: 'computer.list' })).status).toBe(401);
  });

  it('answers sandboxed agents through the file mailbox', async () => {
    const { mailboxDir } = await import('../server/mailbox.js');
    const dir = mailboxDir();
    expect(dir).toContain('palco-mailbox-');
    const id = 'teste-mailbox';
    fs.writeFileSync(path.join(dir, `${id}.req.json`), JSON.stringify({ id, token, argv: ['list'], callerId: alpha }));
    expect(await until(() => fs.existsSync(path.join(dir, `${id}.res.json`)), 5000)).toBe(true);
    const res = JSON.parse(fs.readFileSync(path.join(dir, `${id}.res.json`), 'utf8'));
    expect(res.code).toBe(0);
    expect(res.out).toContain('You: Alpha');
    fs.writeFileSync(path.join(dir, 'x.req.json'), JSON.stringify({ id: 'x', token: 'errado', argv: ['list'] }));
    expect(await until(() => fs.existsSync(path.join(dir, 'x.res.json')), 5000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'x.res.json'), 'utf8')).code).toBe(2);
  });

  it('chat: say lands in the chat log', async () => {
    expect((await cli(alpha, 'say', 'olá do agente')).code).toBe(0);
    const log = await op<{ from: string; text: string }[]>('chat.read', { nodeId: alpha });
    expect(log.at(-1)).toMatchObject({ from: 'agent', text: 'olá do agente' });
  });
});

describe('portals', () => {
  it('drives a headless browser page by @refs', async () => {
    const { findChrome } = await import('../server/portals.js');
    if (!findChrome()) return; // no browser on this machine: nothing to drive
    const ws = srv.store.workspaces.get(wsId)!;
    const me = ws.nodes.find((n) => (n.data as { name: string }).name === 'Alpha')!;
    const html = '<title>Teste</title><input placeholder="nome"><button onclick="document.title=document.querySelector(\'input\').value">Salvar</button>';
    const made = await cli(me.id, 'portal', 'create', 'Navegador', `data:text/html,${encodeURIComponent(html)}`);
    expect(made.code).toBe(0);
    const snap = (await cli(me.id, 'portal', 'snapshot', 'Navegador')).out;
    const input = snap.match(/textbox "nome".*@(e\d+)/)?.[1];
    const button = snap.match(/button "Salvar".*@(e\d+)/)?.[1];
    expect(input && button).toBeTruthy();
    expect((await cli(me.id, 'portal', 'fill', 'Navegador', `@${input}`, 'Palco')).code).toBe(0);
    expect((await cli(me.id, 'portal', 'click', 'Navegador', `@${button}`)).code).toBe(0);
    expect((await cli(me.id, 'portal', 'info', 'Navegador')).out).toContain('título: Palco');
    const shot = (await cli(me.id, 'portal', 'screenshot', 'Navegador')).out.trim();
    expect(fs.existsSync(shot)).toBe(true);
    expect((await cli(me.id, 'portal', 'click', 'Navegador', 'nada')).out).toMatch(/Referência inválida/);
  }, 60000);
});

describe('floors', () => {
  it('creates a git worktree floor, lands it and cleans up', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'um\n');
    g('add', '.');
    g('commit', '-qm', 'init');
    const ws = await op('ws.create', { name: 'Repo', dir: repo });
    const created = await op<{ floor: { dir: string; branch: string } }>('floor.create', { wsId: ws.id, name: 'Experimento' });
    expect(created.floor.branch).toBe('palco/experimento');
    expect(fs.existsSync(path.join(created.floor.dir, 'a.txt'))).toBe(true);
    fs.writeFileSync(path.join(created.floor.dir, 'b.txt'), 'dois\n');
    execFileSync('git', ['add', '.'], { cwd: created.floor.dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], { cwd: created.floor.dir });
    const landed = await op<string>('floor.land', { wsId: ws.id, name: 'Experimento', opts: { deleteBranch: true } });
    expect(landed).toContain('integrado');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(fs.existsSync(created.floor.dir)).toBe(false);
    expect(g('branch', '--list', 'palco/experimento').trim()).toBe('');
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.palco/');
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('floors without git', () => {
  it('copies the project without recursing into its own floors folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-plain-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'um');
    const ws = await op('ws.create', { name: 'Plain', dir });
    const first = await op<{ floor: { dir: string } }>('floor.create', { wsId: ws.id, name: 'Um', opts: { noGit: true } });
    const second = await op<{ floor: { dir: string } }>('floor.create', { wsId: ws.id, name: 'Dois', opts: { noGit: true } });
    expect(fs.readFileSync(path.join(first.floor.dir, 'a.txt'), 'utf8')).toBe('um');
    expect(fs.existsSync(path.join(second.floor.dir, '.palco'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to clone the home directory', async () => {
    const ws = await op('ws.create', { name: 'Casa', dir: os.homedir() });
    await expect(op('floor.create', { wsId: ws.id, name: 'X', opts: { noGit: true } })).rejects.toThrow(/pasta pessoal/);
  });
});

describe('persistence', () => {
  it('writes workspaces to disk', async () => {
    srv.store.flushAll();
    const f = path.join(HOME, 'workspaces', wsId, 'workspace.json');
    const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(saved.nodes.some((n: { data: { name: string } }) => n.data.name === 'Alpha')).toBe(true);
  });
});
