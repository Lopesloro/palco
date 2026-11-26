import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { PALCO_HOME, PKG_ROOT } from './paths.js';
import { PalcoError } from './core.js';

export const HELPER_APP = process.env.PALCO_HELPER_APP || path.join(PKG_ROOT, 'dist', 'Palco Helper.app');

export const helperAvailable = () => process.platform === 'darwin' && fs.existsSync(path.join(HELPER_APP, 'Contents', 'MacOS', 'palco-helper'));

let chain: Promise<unknown> = Promise.resolve();

/**
 * Runs one request through Palco Helper.app. It is launched with `open` so macOS treats the
 * helper as its own app for privacy permissions. `open -W` loses track of helpers that exit
 * quickly, so we wait for the response file instead. Calls are serialized: input events from
 * two agents must never interleave.
 */
export function callHelper(req: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  const run = async () => {
    if (!helperAvailable()) {
      throw new PalcoError('O Palco Helper não está instalado (precisa de macOS com swiftc). Rode ./scripts/install.sh de novo.');
    }
    const dir = path.join(PALCO_HOME, 'helper');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    const reqFile = path.join(dir, `${id}.req.json`);
    const resFile = path.join(dir, `${id}.res.json`);
    // `open` does not pass our environment to the app, so the data folder travels in the request.
    fs.writeFileSync(reqFile, JSON.stringify({ home: PALCO_HOME, ...req }), { mode: 0o600 });
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('open', ['-n', '-g', '-a', HELPER_APP, '--args', reqFile, resFile], { env: { ...process.env, PALCO_HOME } }, (err) => (err ? reject(err) : resolve()));
      });
      const end = Date.now() + timeoutMs;
      while (!fs.existsSync(resFile)) {
        if (Date.now() > end) throw new PalcoError('O Palco Helper não respondeu a tempo.');
        await new Promise((r) => setTimeout(r, 60));
      }
      const res = JSON.parse(fs.readFileSync(resFile, 'utf8')) as { ok: boolean; out?: string; error?: string };
      if (!res.ok) throw new PalcoError(res.error || 'falha no Palco Helper');
      return res.out ?? '';
    } finally {
      fs.rmSync(reqFile, { force: true });
      fs.rmSync(resFile, { force: true });
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
