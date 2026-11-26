import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PALCO_HOME = process.env.PALCO_HOME || path.join(os.homedir(), '.palco');
export const CONFIG_FILE = path.join(PALCO_HOME, 'config.json');
export const WORKSPACES_DIR = path.join(PALCO_HOME, 'workspaces');
export const LOG_DIR = path.join(PALCO_HOME, 'logs');
export const SHOTS_DIR = path.join(PALCO_HOME, 'screenshots');

const here = path.dirname(fileURLToPath(import.meta.url));
/** Root of the installed package (works from both server/ via tsx and dist/server/). */
export const PKG_ROOT = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, '..', '..')
  : path.resolve(here, '..');
export const WEB_DIR = path.join(PKG_ROOT, 'dist', 'web');
export const CLI_BIN_DIR = path.join(PALCO_HOME, 'bin');

export function wsDir(id: string) {
  return path.join(WORKSPACES_DIR, id);
}
