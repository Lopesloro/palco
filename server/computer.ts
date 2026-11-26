import crypto from 'node:crypto';
import { Core, PalcoError, nameOf } from './core.js';
import { callHelper } from './native.js';
import type { Parsed } from './commands.js';

export interface ComputerRequest {
  id: string;
  nodeId: string;
  name: string;
  action: string;
  at: string;
}

interface Pending extends ComputerRequest {
  resolve: (minutes: number | false) => void;
}

const ASK_TIMEOUT_MS = 120_000;

/**
 * Computer use: agents drive other macOS apps through Palco Helper.
 * Every agent must be allowed by the human first, for a limited time, and the human can
 * revoke everyone at once. Each action is announced so the canvas shows who is driving.
 */
export class Computer {
  grants = new Map<string, number>(); // nodeId -> expiry (ms)
  pending = new Map<string, Pending>();

  constructor(private core: Core) {}

  list() {
    const now = Date.now();
    for (const [id, until] of this.grants) if (until <= now) this.grants.delete(id);
    return {
      grants: [...this.grants].map(([nodeId, until]) => ({ nodeId, name: nameOf(this.core.nodeById(nodeId) ?? ({ data: {} } as never)), until: new Date(until).toISOString() })),
      pending: [...this.pending.values()].map(({ resolve: _r, ...p }) => p),
    };
  }

  decide(id: string, minutes: number | false) {
    const p = this.pending.get(id);
    if (!p) throw new PalcoError('Pedido não encontrado (talvez já tenha expirado).');
    this.pending.delete(id);
    p.resolve(minutes);
    this.core.emit('computer', this.list());
  }

  revokeAll() {
    this.grants.clear();
    for (const p of [...this.pending.values()]) this.decide(p.id, false);
    this.core.emit('computer', this.list());
    this.core.emit('computer-activity', { name: 'Você', action: 'parou todo o computer use' });
  }

  private async ensureGrant(callerId: string | undefined, action: string) {
    if (!callerId) return 'Você';
    const node = this.core.nodeById(callerId);
    if (!node) throw new PalcoError('Terminal desconhecido.');
    const name = nameOf(node);
    const until = this.grants.get(callerId);
    if (until && until > Date.now()) return name;
    const req: ComputerRequest = { id: crypto.randomUUID(), nodeId: callerId, name, action, at: new Date().toISOString() };
    const minutes = await new Promise<number | false>((resolve) => {
      this.pending.set(req.id, { ...req, resolve });
      this.core.emit('computer', this.list());
      this.core.notify(`${name} quer usar o computador (${action}). Responda no Palco.`, 'Palco: pedido de controle');
      setTimeout(() => {
        if (this.pending.has(req.id)) this.decide(req.id, false);
      }, ASK_TIMEOUT_MS).unref();
    });
    if (minutes === false) throw new PalcoError('O usuário não autorizou o uso do computador (ou não respondeu em 2 minutos). Não tente contornar: peça a ele pelo chat se precisar.');
    this.grants.set(callerId, Date.now() + minutes * 60_000);
    this.core.emit('computer', this.list());
    return name;
  }

  async run(p: Parsed, callerId: string | undefined): Promise<string> {
    const [sub, ...args] = p.pos;
    const flag = (k: string) => (typeof p.flags[k] === 'string' ? (p.flags[k] as string) : undefined);
    const num = (v: string | undefined, label: string) => {
      const n = Number(v);
      if (v === undefined || Number.isNaN(n)) throw new PalcoError(`Informe ${label} numérico.`);
      return n;
    };
    let req: Record<string, unknown>;
    switch (sub) {
      case 'trust': req = { cmd: 'trust' }; break;
      case 'apps': req = { cmd: 'apps' }; break;
      case 'open': case 'focus': req = { cmd: sub, app: need(args[0], 'o nome do app') }; break;
      case 'windows': req = { cmd: 'windows', app: args[0] ?? '' }; break;
      case 'screenshot': req = { cmd: 'screenshot', app: args[0] ?? '' }; break;
      case 'snapshot': req = { cmd: 'snapshot', app: need(args[0], 'o nome do app') }; break;
      case 'click': req = { cmd: 'click', app: need(args[0], 'o nome do app'), ref: need(args[1], 'a referência @eN') }; break;
      case 'fill': req = { cmd: 'fill', app: need(args[0], 'o nome do app'), ref: need(args[1], 'a referência @eN'), text: args[2] ?? '' }; break;
      case 'click-at': req = { cmd: 'click-at', x: num(args[0], 'x'), y: num(args[1], 'y'), right: !!p.flags.right, double: !!p.flags.double }; break;
      case 'type': req = { cmd: 'type', text: args.join(' ') }; break;
      case 'key': req = { cmd: 'key', key: need(args[0], 'a tecla (ex.: cmd+s)') }; break;
      case 'scroll': req = { cmd: 'scroll', dy: num(args[0] ?? '400', 'a distância'), dx: Number(flag('dx') ?? 0), ...(args[1] ? { x: num(args[1], 'x'), y: num(args[2], 'y') } : {}) }; break;
      case undefined: case 'help':
        return COMPUTER_HELP;
      default:
        throw new PalcoError(`Subcomando desconhecido: ${sub}\n${COMPUTER_HELP}`);
    }
    const describe = [sub, ...args.slice(0, 2)].join(' ');
    const who = await this.ensureGrant(callerId, describe);
    this.core.emit('computer-activity', { name: who, action: describe });
    return callHelper(req);
  }
}

function need(v: string | undefined, what: string) {
  if (!v) throw new PalcoError(`Informe ${what}.`);
  return v;
}

export const COMPUTER_HELP = `palco computer — operar outros apps do Mac (pede autorização ao usuário na primeira vez)
  apps                          apps abertos
  open "App" | focus "App"      abre ou traz para frente
  windows ["App"]               janelas visíveis com posição e tamanho
  screenshot ["App"]            PNG da tela ou da janela do app (imprime o caminho)
  snapshot "App"                elementos da janela em foco como @eN
  click "App" @eN               pressiona o elemento
  fill "App" @eN "texto"        preenche um campo
  click-at X Y [--right] [--double]
  type "texto"                  digita no app em foco
  key "cmd+s"                   atalho de teclado (cmd, ctrl, alt, shift + tecla)
  scroll DY [X Y]               rola (positivo = para baixo)
  trust                         pede a permissão de Acessibilidade ao macOS`;
