import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PALCO_HOME } from './paths.js';

/**
 * Agents such as Codex run their shell commands in a sandbox with no network, so `palco` cannot
 * reach 127.0.0.1. The sandbox can still write to the user's temp folder, so the CLI drops a request
 * file here and the server answers with a response file next to it.
 */
let cached: string | undefined;
export function mailboxDir() {
  if (process.env.PALCO_MAILBOX) return process.env.PALCO_MAILBOX;
  if (cached) return cached;
  let tmp = os.tmpdir();
  if (process.platform === 'darwin') {
    try { tmp = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR']).toString().trim() || tmp; } catch { /* keep os.tmpdir */ }
  }
  // one mailbox per Palco installation, so a test server never answers the real one's agents
  const home = crypto.createHash('sha1').update(PALCO_HOME).digest('hex').slice(0, 8);
  cached = path.join(tmp, `palco-mailbox-${process.getuid?.() ?? 'u'}-${home}`);
  return cached;
}

export interface MailRequest {
  id: string;
  token: string;
  argv: string[];
  callerId?: string;
  stdin?: string;
}

export interface Identity { human?: boolean; callerId?: string }
type Handler = (req: MailRequest, who: Identity) => Promise<{ out: string; code: number }>;

export class Mailbox {
  readonly dir = mailboxDir();
  private seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;

  constructor(private identify: (token: string) => Identity | undefined, private handle: Handler) {}

  start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true }); // stale files from a previous run
    try {
      this.watcher = fs.watch(this.dir, () => this.scan());
    } catch { /* polling below still works */ }
    this.timer = setInterval(() => this.scan(), 400);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.watcher?.close();
  }

  private scan() {
    let files: string[];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.req.json') || this.seen.has(f)) continue;
      this.seen.add(f);
      void this.process(f);
    }
  }

  private async process(file: string) {
    const full = path.join(this.dir, file);
    let req: MailRequest;
    try {
      req = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      this.seen.delete(file);
      return;
    } finally {
      fs.rmSync(full, { force: true });
    }
    const id = String(req.id ?? '').replace(/[^\w-]/g, '');
    let res: { out: string; code: number };
    if (!id) return;
    const who = this.identify(String(req.token ?? ''));
    if (!who) res = { out: 'Token recusado pelo Palco.', code: 2 };
    else {
      try { res = await this.handle(req, who); } catch (e) { res = { out: (e as Error).message, code: 1 }; }
    }
    const out = path.join(this.dir, `${id}.res.json`);
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(res), { mode: 0o600 });
    fs.renameSync(tmp, out);
    this.seen.delete(file);
  }
}
