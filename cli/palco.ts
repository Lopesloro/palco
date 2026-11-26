#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.PALCO_HOME || path.join(os.homedir(), '.palco');
const CONFIG = path.join(HOME, 'config.json');
const LOG = path.join(HOME, 'logs', 'server.log');
const LABEL = 'app.palco.server';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, '..', '..') : path.resolve(here, '..');
const SERVER_JS = path.join(PKG, 'dist', 'server', 'index.js');

function readConfig(): { token: string; port: number } | undefined {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return undefined; }
}
const port = () => Number(process.env.PALCO_PORT || readConfig()?.port || 4747);
const base = () => process.env.PALCO_URL || `http://127.0.0.1:${port()}`;
const token = () => process.env.PALCO_TOKEN || readConfig()?.token || '';

async function health(): Promise<{ ok: boolean; version: string; pid: number } | undefined> {
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as { ok: boolean; version: string; pid: number }) : undefined;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = await health();
    if (h) return h;
    await sleep(300);
  }
  return undefined;
}

const uidNum = () => process.getuid?.() ?? Number(execFileSync('id', ['-u']).toString().trim());
const launchctl = (...args: string[]) => {
  try { return execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return (e as { stderr?: Buffer }).stderr?.toString() ?? ''; }
};
const installed = () => process.platform === 'darwin' && fs.existsSync(PLIST);
const jobLoaded = () => {
  try { execFileSync('launchctl', ['print', `gui/${uidNum()}/${LABEL}`], { stdio: 'ignore' }); return true; } catch { return false; }
};

/** bootout returns before launchd finishes unloading; bootstrap during that window fails with EIO. */
async function unloadJob() {
  launchctl('bootout', `gui/${uidNum()}/${LABEL}`);
  for (let i = 0; i < 40 && jobLoaded(); i++) await sleep(250);
}

async function loadJob() {
  let out = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (jobLoaded()) return '';
    out = launchctl('bootstrap', `gui/${uidNum()}`, PLIST);
    if (jobLoaded()) return '';
    await sleep(600);
  }
  return out.trim();
}

function plistXml() {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const env: Record<string, string> = {
    PATH: [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath), process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    HOME: os.homedir(),
    SHELL: process.env.SHELL || '/bin/zsh',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PALCO_HOME: HOME,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(SERVER_JS)}</string></array>
  <key>WorkingDirectory</key><string>${esc(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
</dict>
</plist>
`;
}

function linkBin() {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, 'palco');
  const shim = `#!/bin/sh\nexec "${process.execPath}" "${path.join(PKG, 'dist', 'cli', 'palco.js')}" "$@"\n`;
  fs.writeFileSync(target, shim, { mode: 0o755 });
  const onPath = (process.env.PATH || '').split(':').includes(binDir);
  return onPath ? target : `${target}  (adicione ~/.local/bin ao PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc)`;
}

/** Lets Claude Code (and Codex, when present) discover the `palco` commands. */
function installSkills() {
  const src = path.join(PKG, 'skills', 'palco', 'SKILL.md');
  if (!fs.existsSync(src)) return [];
  const done: string[] = [];
  for (const root of [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.codex')]) {
    if (!fs.existsSync(root)) continue;
    const dir = path.join(root, 'skills', 'palco');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'SKILL.md'));
    done.push(dir);
  }
  return done;
}

async function install() {
  if (process.platform !== 'darwin') throw new Error('O serviço automático usa launchd (macOS). Em outro sistema, rode `palco start`.');
  if (!fs.existsSync(SERVER_JS)) throw new Error(`Build ausente em ${SERVER_JS}. Rode npm run build.`);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const h = await health();
  if (h && !installed()) {
    try { process.kill(h.pid, 'SIGTERM'); } catch { /* not ours */ }
    await sleep(1000);
  }
  await unloadJob();
  fs.writeFileSync(PLIST, plistXml());
  const out = await loadJob();
  if (out) console.error(out);
  const ok = await waitHealthy(20000);
  console.log(`Serviço launchd instalado (${LABEL}): sobe no login e reinicia se cair.`);
  console.log(`Comando: ${linkBin()}`);
  const skills = installSkills();
  if (skills.length) console.log(`Skill dos agentes: ${skills.join(', ')}`);
  if (!ok) throw new Error(`O serviço não respondeu. Veja: palco logs`);
  console.log(`Palco ${ok.version} no ar em ${base()}`);
}

async function uninstall() {
  await unloadJob();
  fs.rmSync(PLIST, { force: true });
  console.log('Serviço removido. Seus dados continuam em', HOME);
}

async function ensureRunning() {
  const h = await health();
  if (h) return h;
  if (installed()) {
    // `palco stop` boots the job out of launchd, so load it again before kicking it
    await loadJob();
    launchctl('kickstart', `gui/${uidNum()}/${LABEL}`);
  } else {
    if (!fs.existsSync(SERVER_JS)) throw new Error(`Build ausente em ${SERVER_JS}. Rode npm run build.`);
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const fd = fs.openSync(LOG, 'a');
    spawn(process.execPath, [SERVER_JS], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PALCO_HOME: HOME } }).unref();
  }
  const ok = await waitHealthy();
  if (!ok) throw new Error(`O Palco não subiu. Veja: palco logs`);
  return ok;
}

function openBrowser(u: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [u], { detached: true, stdio: 'ignore' }).unref();
}

async function stop() {
  if (installed()) {
    await unloadJob();
    console.log('Serviço parado (volta no próximo login ou com `palco start`).');
    return;
  }
  const h = await health();
  if (!h) return console.log('O Palco não está rodando.');
  process.kill(h.pid, 'SIGTERM');
  console.log('Palco parado.');
}

async function start() {
  if (installed() && !(await health())) await loadJob();
  const h = await ensureRunning();
  console.log(`Palco ${h.version} no ar em ${base()}`);
}

async function doctor() {
  const row = (ok: boolean, label: string, extra = '') => console.log(`${ok ? '✔' : '✘'} ${label}${extra ? ` — ${extra}` : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  row(major >= 20, `Node ${process.versions.node}`, major >= 20 ? '' : 'precisa de 20+');
  row(fs.existsSync(SERVER_JS), 'build', SERVER_JS);
  const h = await health();
  row(!!h, 'servidor', h ? `${base()} (pid ${h.pid})` : 'parado — rode `palco`');
  row(installed(), 'serviço launchd', installed() ? PLIST : 'não instalado — rode `palco install`');
  for (const bin of ['claude', 'codex', 'opencode', 'gemini', 'git', 'tmux']) {
    let where = '';
    try { where = execFileSync('/bin/sh', ['-lc', `command -v ${bin}`]).toString().trim(); } catch { /* missing */ }
    row(!!where, bin, where || 'não encontrado (opcional)');
  }
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((c) => fs.existsSync(c)) || process.env.PALCO_CHROME;
  row(!!chrome, 'navegador para portais', chrome || 'instale o Google Chrome ou defina PALCO_CHROME');
}

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 400));
  const reading = (async () => { for await (const c of process.stdin) chunks.push(c as Buffer); return 'done' as const; })();
  const first = await Promise.race([reading, timer]);
  if (first === 'timeout' && chunks.length === 0) {
    process.stdin.destroy(); // an inherited pipe that never closes must not keep us alive
    return undefined;
  }
  if (first === 'timeout') await reading;
  const s = Buffer.concat(chunks).toString('utf8');
  return s.length ? s.replace(/\n$/, '') : undefined;
}

async function agentCommand(argv: string[]) {
  const h = await health();
  if (!h) {
    console.error('O Palco não está rodando. Rode `palco` para abrir.');
    process.exit(2);
  }
  const needsStdin = ['say', 'ask', 'notify', 'note'].includes(argv[0]);
  const stdin = needsStdin ? await readStdin() : undefined;
  const timeoutIdx = argv.indexOf('--timeout');
  const extra = timeoutIdx >= 0 ? 60_000 : 0;
  const r = await fetch(`${base()}/api/cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ argv, callerId: process.env.PALCO_TERMINAL_ID, stdin }),
    signal: AbortSignal.timeout(6 * 3_600_000 + extra),
  });
  if (r.status === 401) {
    console.error('Token recusado. Este terminal foi aberto por outra instalação do Palco?');
    process.exit(2);
  }
  const body = (await r.json()) as { out?: string; code?: number; error?: string };
  const out = body.out ?? body.error ?? '';
  if (body.code) { console.error(out); process.exit(body.code); }
  if (out) console.log(out);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case undefined: case 'open': {
      const h = await ensureRunning();
      const u = `${base()}/#token=${token()}`;
      openBrowser(u);
      console.log(`Palco ${h.version} aberto em ${base()}`);
      return;
    }
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': await stop(); await sleep(800); return start();
    case 'status': {
      const h = await health();
      console.log(h ? `no ar: ${base()} (versão ${h.version}, pid ${h.pid})` : 'parado');
      console.log(installed() ? `serviço launchd: instalado (${LABEL})` : 'serviço launchd: não instalado (`palco install`)');
      return;
    }
    case 'logs': {
      if (!fs.existsSync(LOG)) return console.log('Sem logs ainda.');
      const args = argv.includes('-f') || argv.includes('--follow') ? ['-n', '100', '-f', LOG] : ['-n', '200', LOG];
      spawn('tail', args, { stdio: 'inherit' });
      return;
    }
    case 'install': return install();
    case 'uninstall': return uninstall();
    case 'doctor': return doctor();
    case 'url': return console.log(`${base()}/#token=${token()}`);
    case 'version': case '--version': case '-v': return console.log(JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version);
    default: return agentCommand(argv);
  }
}

const KEEP_ALIVE = new Set(['logs']);
main().then(() => {
  // exit only after stdout drains: a big `portal html` piped elsewhere must not be cut short
  if (!KEEP_ALIVE.has(process.argv[2] ?? '')) process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
