import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Core, PalcoError } from './core.js';
import { uid, now } from './store.js';
import type { Floor, FloorState, Workspace } from './types.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new PalcoError(`git ${args[0]}: ${(e.stderr || e.message).trim()}`);
  }
}

export async function isGitRepo(dir: string) {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'andar';

export interface FloorCreateOpts {
  branch?: string;
  existingBranch?: boolean;
  from?: string;
  copy?: boolean;
  noGit?: boolean;
  dir?: string;
  pullRequest?: string;
}

export class Floors {
  constructor(private core: Core) {}

  list(ws: Workspace) {
    return ws.floors.map((f) => {
      const agents = ws.nodes.filter((n) => n.floorId === f.id && n.type === 'terminal').length;
      return { ...f, agents };
    });
  }

  async create(ws: Workspace, name: string, opts: FloorCreateOpts = {}): Promise<{ floor: Floor; note: string }> {
    if (ws.floors.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new PalcoError(`Já existe um andar "${name}".`);
    const ground = this.core.groundOf(ws);
    const floor: Floor = { id: uid(), name, dir: ground.dir, ground: false, git: false, createdAt: now() };
    let note = '';

    if (opts.dir) {
      if (!fs.existsSync(opts.dir)) throw new PalcoError(`Pasta não existe: ${opts.dir}`);
      floor.dir = path.resolve(opts.dir);
      note = 'Andar apontando para a pasta informada.';
    } else {
      const src = ground.dir;
      const isRepo = !opts.noGit && (await isGitRepo(src));
      const floorsRoot = path.join(src, '.palco', 'floors');
      const target = path.join(floorsRoot, slug(name));
      if (fs.existsSync(target)) throw new PalcoError(`A pasta do andar já existe: ${target}`);
      if (isRepo) {
        await this.excludePalcoDir(src);
        let branch = opts.branch || `palco/${slug(name)}`;
        const base = opts.from || (await git(src, 'rev-parse', '--abbrev-ref', 'HEAD'));
        if (opts.pullRequest) {
          const num = opts.pullRequest.match(/(\d+)\/?$/)?.[1];
          if (!num) throw new PalcoError('Número ou URL de pull request inválido.');
          branch = `pr-${num}`;
          await git(src, 'fetch', 'origin', `pull/${num}/head:${branch}`);
          opts.existingBranch = true;
        }
        fs.mkdirSync(floorsRoot, { recursive: true });
        if (opts.existingBranch) await git(src, 'worktree', 'add', target, branch);
        else await git(src, 'worktree', 'add', '-b', branch, target, base);
        floor.git = true;
        floor.branch = branch;
        floor.baseBranch = base;
        if (opts.copy) await this.cloneUntracked(src, target);
        note = `Worktree git em ${target} no branch ${branch}${opts.copy ? ' (arquivos não rastreados clonados por copy-on-write)' : ''}.`;
      } else {
        const resolved = path.resolve(src);
        if (resolved === os.homedir() || resolved === path.parse(resolved).root) {
          throw new PalcoError('Não copio a pasta pessoal nem a raiz do disco. Aponte o workspace para a pasta do projeto antes de criar o andar.');
        }
        fs.mkdirSync(target, { recursive: true });
        // Copy entry by entry so the floors folder (which lives inside src) is never copied into itself.
        // cp -c makes APFS copy-on-write clones: instant, no extra disk until files change.
        for (const entry of fs.readdirSync(src)) {
          if (entry === '.palco') continue;
          const from = path.join(src, entry);
          await exec('cp', ['-cR', from, target]).catch(() => exec('cp', ['-R', from, target]));
        }
        note = `Cópia isolada (copy-on-write) em ${target}.`;
      }
      floor.dir = target;
    }
    ws.floors.push(floor);
    this.core.store.touch(ws);
    return { floor, note };
  }

  /** Clone ignored/untracked files (node_modules, .env...) into the worktree with APFS clones. */
  private async cloneUntracked(src: string, target: string) {
    const out = await git(src, 'ls-files', '--others', '--directory', '--no-empty-directory');
    for (const rel of out.split('\n').filter((l) => l && !l.startsWith('.palco'))) {
      const from = path.join(src, rel);
      const to = path.join(target, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      await exec('cp', ['-cR', from.replace(/\/$/, ''), path.dirname(to)]).catch(() => {});
    }
  }

  private async excludePalcoDir(repo: string) {
    try {
      const gitDir = await git(repo, 'rev-parse', '--git-common-dir');
      const excl = path.resolve(repo, gitDir, 'info', 'exclude');
      fs.mkdirSync(path.dirname(excl), { recursive: true });
      const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
      if (!cur.split('\n').includes('.palco/')) fs.appendFileSync(excl, `${cur.endsWith('\n') || !cur ? '' : '\n'}.palco/\n`);
    } catch { /* not fatal */ }
  }

  async remove(ws: Workspace, name: string, opts: { keepBranch?: boolean; keepFolder?: boolean; force?: boolean } = {}) {
    const floor = this.core.floorByName(ws, name)!;
    if (floor.ground) throw new PalcoError('O térreo não pode ser apagado.');
    for (const n of ws.nodes.filter((x) => x.floorId === floor.id)) this.core.removeNode(ws, n.id);
    const ground = this.core.groundOf(ws);
    if (!opts.keepFolder && floor.dir.includes(`${path.sep}.palco${path.sep}floors${path.sep}`)) {
      if (floor.git) {
        if (!opts.force) {
          const dirty = await git(floor.dir, 'status', '--porcelain').catch(() => '');
          if (dirty) throw new PalcoError(`O andar tem mudanças não commitadas. Commite, ou use --force para descartar.`);
        }
        await git(ground.dir, 'worktree', 'remove', '--force', floor.dir);
      } else {
        fs.rmSync(floor.dir, { recursive: true, force: true });
      }
    }
    if (floor.git && floor.branch && !opts.keepBranch) {
      await git(ground.dir, 'branch', opts.force ? '-D' : '-d', floor.branch).catch((e) => {
        if (!opts.force) throw new PalcoError(`${(e as Error).message}\nO branch não foi integrado. Use --keep-branch para guardar ou --force para apagar.`);
      });
    }
    ws.floors = ws.floors.filter((f) => f.id !== floor.id);
    this.core.store.touch(ws);
    return `Andar "${floor.name}" removido.`;
  }

  async land(ws: Workspace, name: string, opts: { into?: string; deleteBranch?: boolean; keepFloor?: boolean } = {}) {
    const floor = this.core.floorByName(ws, name)!;
    if (!floor.git || !floor.branch) throw new PalcoError('Só andares com git podem ser integrados (land).');
    const ground = this.core.groundOf(ws);
    const dirty = await git(floor.dir, 'status', '--porcelain');
    if (dirty) throw new PalcoError('O andar tem mudanças não commitadas. Peça ao agente para commitar antes do land.');
    const groundDirty = await git(ground.dir, 'status', '--porcelain', '--untracked-files=no');
    if (groundDirty) throw new PalcoError('O térreo tem mudanças não commitadas; o merge não vai sobrescrever trabalho seu.');
    const into = opts.into || floor.baseBranch || (await git(ground.dir, 'rev-parse', '--abbrev-ref', 'HEAD'));
    const current = await git(ground.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (current !== into) {
      throw new PalcoError(`O térreo está no branch ${current}, não em ${into}. Mude o térreo para ${into} (ou use --into ${current}); o Palco não troca o branch da sua cópia principal.`);
    }
    try {
      await git(ground.dir, 'merge', '--no-ff', '-m', `Land floor ${floor.name} (${floor.branch})`, floor.branch);
    } catch (err) {
      await git(ground.dir, 'merge', '--abort').catch(() => {});
      throw new PalcoError(`Conflito no merge de ${floor.branch} em ${into}; nada foi alterado. Resolva no andar (rebase em ${into}) e tente de novo.\n${(err as Error).message}`);
    }
    let msg = `Branch ${floor.branch} integrado em ${into}.`;
    if (!opts.keepFloor) {
      msg += ' ' + (await this.remove(ws, name, { keepBranch: !opts.deleteBranch, force: false }));
    }
    return msg;
  }

  status(ws: Workspace, floorName: string | undefined, callerFloorId: string | undefined, text: string | undefined, opts: { state?: FloorState; progress?: string; clear?: boolean }) {
    const floor = floorName ? this.core.floorByName(ws, floorName)! : ws.floors.find((f) => f.id === callerFloorId) ?? this.core.groundOf(ws);
    if (opts.clear) floor.status = undefined;
    else floor.status = { text: text ?? floor.status?.text ?? '', state: opts.state ?? floor.status?.state, progress: opts.progress ?? floor.status?.progress, updatedAt: now() };
    this.core.store.touch(ws);
    return `Status de "${floor.name}": ${floor.status ? `${floor.status.state ?? ''} ${floor.status.progress ?? ''} ${floor.status.text}`.trim() : '(limpo)'}`;
  }

  setDir(ws: Workspace, name: string, dir: string) {
    const floor = this.core.floorByName(ws, name)!;
    if (!fs.existsSync(dir)) throw new PalcoError(`Pasta não existe: ${dir}`);
    floor.dir = path.resolve(dir);
    if (floor.ground) ws.dir = floor.dir;
    this.core.store.touch(ws);
    return `Pasta de "${floor.name}" agora é ${floor.dir}. Terminais novos começam lá.`;
  }

  unload(ws: Workspace, name: string) {
    const floor = this.core.floorByName(ws, name)!;
    for (const n of ws.nodes.filter((x) => x.floorId === floor.id && x.type === 'terminal')) this.core.sessions.stop(n.id, false);
    floor.unloaded = true;
    this.core.store.touch(ws);
    return `Andar "${floor.name}" descarregado; os agentes acordam no próximo ask.`;
  }

  load(ws: Workspace, floorId: string) {
    const floor = ws.floors.find((f) => f.id === floorId);
    if (!floor) return;
    floor.unloaded = false;
    for (const n of ws.nodes.filter((x) => x.floorId === floor.id && x.type === 'terminal')) {
      if (!this.core.sessions.get(n.id)) this.core.sessions.start(ws, n);
    }
    this.core.store.touch(ws);
  }
}
