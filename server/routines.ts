import { Cron } from 'croner';
import { Core, PalcoError, nameOf } from './core.js';
import { uid, now } from './store.js';
import { typePrompt } from './sessions.js';
import type { Routine, RoutineSchedule, Workspace } from './types.js';

/** "10m", "2h", "1d", "30s" -> cron-like interval in seconds. */
export function parseEvery(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) throw new PalcoError(`Intervalo inválido "${s}". Use 30s, 10m, 2h ou 1d.`);
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
  if (n * mult < 30) throw new PalcoError('O intervalo mínimo é 30s.');
  return n * mult;
}

export function describeSchedule(s: RoutineSchedule) {
  if (s.cron) return `cron "${s.cron}"`;
  if (s.every) return `a cada ${s.every}`;
  if (s.at) return `todo dia às ${s.at}`;
  if (s.once) return `uma vez em ${s.once}`;
  return '(sem agenda)';
}

function toCronPattern(s: RoutineSchedule): string | Date {
  if (s.cron) return s.cron;
  if (s.at) {
    const m = s.at.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new PalcoError(`Horário inválido "${s.at}". Use HH:MM.`);
    return `${Number(m[2])} ${Number(m[1])} * * *`;
  }
  if (s.once) {
    const d = new Date(s.once);
    if (Number.isNaN(d.getTime())) throw new PalcoError(`Data inválida "${s.once}". Use ISO, ex.: 2026-12-01T09:00.`);
    return d;
  }
  if (s.every) {
    parseEvery(s.every); // validated here; "every" runs on a plain interval, not cron
    return '';
  }
  throw new PalcoError('A routine precisa de uma agenda: --every, --at, --cron ou --once.');
}

export class Routines {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(private core: Core) {}

  startAll() {
    for (const ws of this.core.store.workspaces.values()) for (const r of ws.routines) this.schedule(ws, r);
  }

  stopAll() {
    for (const id of [...this.jobs.keys(), ...this.intervals.keys()]) this.unschedule(id);
  }

  unschedule(id: string) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    clearInterval(this.intervals.get(id));
    this.intervals.delete(id);
  }

  schedule(ws: Workspace, r: Routine) {
    this.unschedule(r.id);
    if (!r.enabled) return;
    if (r.schedule.every) {
      const secs = parseEvery(r.schedule.every);
      const t = setInterval(() => void this.run(ws.id, r.id), secs * 1000);
      t.unref();
      this.intervals.set(r.id, t);
      return;
    }
    const pattern = toCronPattern(r.schedule);
    const job = new Cron(pattern as string, { catch: (e) => console.error('[routine]', e) }, () => void this.run(ws.id, r.id));
    this.jobs.set(r.id, job);
  }

  nextRun(r: Routine) {
    if (!r.enabled) return undefined;
    if (r.schedule.every) {
      const secs = parseEvery(r.schedule.every);
      const base = r.lastRunAt ? new Date(r.lastRunAt).getTime() : Date.now();
      return new Date(Math.max(base + secs * 1000, Date.now())).toISOString();
    }
    return this.jobs.get(r.id)?.nextRun()?.toISOString();
  }

  find(ws: Workspace, name: string) {
    const r = ws.routines.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new PalcoError(`Routine "${name}" não existe. Veja: palco routine list`);
    return r;
  }

  create(ws: Workspace, input: Omit<Routine, 'id'>) {
    if (ws.routines.some((x) => x.name.toLowerCase() === input.name.toLowerCase())) throw new PalcoError(`Já existe a routine "${input.name}".`);
    if (input.kind !== 'reminder' && !input.target) throw new PalcoError('Diga em qual terminal rodar: --target "Nome".');
    if (input.target) this.core.byName(input.target, ws, ['terminal']);
    toCronPattern(input.schedule);
    const r: Routine = { id: uid(), ...input };
    ws.routines.push(r);
    this.schedule(ws, r);
    this.core.store.touch(ws);
    return r;
  }

  update(ws: Workspace, name: string, patch: Partial<Routine>) {
    const r = this.find(ws, name);
    Object.assign(r, patch);
    if (patch.schedule) toCronPattern(r.schedule);
    this.schedule(ws, r);
    this.core.store.touch(ws);
    return r;
  }

  remove(ws: Workspace, name: string) {
    const r = this.find(ws, name);
    this.unschedule(r.id);
    ws.routines = ws.routines.filter((x) => x.id !== r.id);
    this.core.store.touch(ws);
  }

  async run(wsId: string, routineId: string, manual = false) {
    const ws = this.core.store.workspaces.get(wsId);
    const r = ws?.routines.find((x) => x.id === routineId);
    if (!ws || !r) return 'routine não encontrada';
    let result: string;
    try {
      if (r.kind === 'reminder') {
        this.core.notify(r.command, `Lembrete: ${r.name}`);
        result = 'lembrete enviado';
      } else {
        const { node } = this.core.byName(r.target!, ws, ['terminal']);
        const s = this.core.session(node.id);
        if (r.skipIfBusy && s.status === 'busy' && !manual) {
          result = `pulada: ${nameOf(node)} estava ocupado`;
        } else {
          if (r.kind === 'prompt') typePrompt(s, `[Palco routine "${r.name}"]\n${r.command}`, (node.data as { agentType?: string }).agentType !== 'shell');
          else s.write(`${r.command}\r`);
          result = `enviada para ${nameOf(node)}`;
        }
      }
    } catch (err) {
      result = `erro: ${(err as Error).message}`;
    }
    r.lastRunAt = now();
    r.lastResult = result;
    if (r.schedule.once) {
      r.enabled = false;
      this.unschedule(r.id);
    }
    this.core.store.touch(ws);
    return result;
  }
}
