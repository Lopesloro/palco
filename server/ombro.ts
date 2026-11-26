import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Core, nameOf } from './core.js';
import { callHelper, helperAvailable } from './native.js';
import { PALCO_HOME } from './paths.js';
import { withoutInputBox } from './sessions.js';
import type { TerminalData } from './types.js';

export interface OmbroEntry {
  id: string;
  nodeId: string;
  wsId: string;
  name: string;
  ts: string;
  text: string;
}

const FILE = path.join(PALCO_HOME, 'ombro.json');
const MIN_BUSY_MS = 15_000;
const COOLDOWN_MS = 45_000;

/** Keeps only the two lines the prompt asks for; the model sometimes adds a pleasantry. */
export function cleanSummary(raw: string) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = lines.filter((l) => /^(resumo|próximo passo|proximo passo)\s*:/i.test(l));
  return (keep.length ? keep : lines.slice(0, 2)).join('\n');
}

/**
 * Ombro watches agents: when one finishes a stretch of work it summarizes the screen with the
 * on-device Apple model and suggests a next step. Nothing leaves the Mac.
 */
export class Ombro {
  entries: OmbroEntry[] = [];
  private busySince = new Map<string, number>();
  private lastRun = new Map<string, number>();
  private queue: string[] = [];
  private working = false;

  constructor(private core: Core) {
    try { this.entries = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { this.entries = []; }
    core.sessions.on('status', (_ws: string, id: string, status: string) => this.onStatus(id, status));
  }

  get enabled() {
    return this.core.store.config.settings.ombro !== false && helperAvailable();
  }

  private onStatus(id: string, status: string) {
    if (status === 'busy') {
      if (!this.busySince.has(id)) this.busySince.set(id, Date.now());
      return;
    }
    const since = this.busySince.get(id);
    this.busySince.delete(id);
    if (status !== 'idle' || since === undefined || !this.enabled) return;
    if (Date.now() - since < MIN_BUSY_MS) return;
    const node = this.core.nodeById(id);
    const d = node?.data as TerminalData | undefined;
    if (!d || d.agentType === 'shell' || (d as { ombro?: boolean }).ombro === false) return;
    if (Date.now() - (this.lastRun.get(id) ?? 0) < COOLDOWN_MS) return;
    this.enqueue(id);
  }

  enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.drain();
  }

  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        await this.summarize(id).catch((e) => console.error('[ombro]', (e as Error).message));
      }
    } finally {
      this.working = false;
    }
  }

  async summarize(id: string) {
    const hit = this.core.store.findWorkspaceOfNode(id);
    const s = this.core.sessions.get(id);
    if (!hit || !s) return undefined;
    this.lastRun.set(id, Date.now());
    const raw = await callHelper({ cmd: 'summarize', name: nameOf(hit.node), text: withoutInputBox(s.tail(140)) }, 90_000);
    const entry: OmbroEntry = { id: crypto.randomUUID(), nodeId: id, wsId: hit.ws.id, name: nameOf(hit.node), ts: new Date().toISOString(), text: cleanSummary(raw) };
    this.entries = [entry, ...this.entries].slice(0, 60);
    fs.writeFileSync(FILE, JSON.stringify(this.entries, null, 2));
    this.core.emit('ombro', entry);
    return entry;
  }

  dismiss(id?: string) {
    this.entries = id ? this.entries.filter((e) => e.id !== id) : [];
    fs.writeFileSync(FILE, JSON.stringify(this.entries, null, 2));
  }
}
