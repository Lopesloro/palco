import fs from 'node:fs';
import path from 'node:path';
import { Core, PalcoError, nameOf } from './core.js';
import type { Floors } from './floors.js';
import type { Routines } from './routines.js';
import { describeSchedule } from './routines.js';
import type { Portals } from './portals.js';
import { uid, now, randomColor } from './store.js';
import type {
  BandData, NoteData, PalcoNode, Partitura, PortalData, Preset, Role, Routine, TerminalData, Workspace,
} from './types.js';

const BOOL = new Set([
  'raw', 'without-me', 'copy', 'copy-ground', 'no-git', 'existing-branch', 'keep-branch', 'keep-folder', 'force',
  'delete-branch', 'keep-floor', 'clear', 'none', 'full', 'no-skip-if-busy', 'skip-if-busy', 'help', 'json', 'root',
  'disable', 'locked', 'unlocked', 'stack',
]);

export interface Parsed {
  pos: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOL.has(key) || next === undefined || (next.startsWith('--') && next.length > 2)) flags[key] = true;
      else { flags[key] = next; i++; }
    } else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

export const HELP = `palco — CLI dos agentes no canvas do Palco

Comunicação
  palco list                                  quem está conectado a você (agentes, bands, notas, portais)
  palco ask "Nome" "prompt" [--timeout 10m]   manda um prompt e espera a resposta
  palco ask --batch '{"A":"p1","B":"p2"}'     vários agentes em paralelo (JSON de saída)
  palco ask "Nome" --raw "2\\n"                entrada crua (\\n Enter, \\t, \\e ESC, \\xNN)
  palco check "Nome"                          lê a tela atual do agente
  palco say "texto" | palco say <<'EOF'       responde no Palco Chat (--file, --attach)
  palco notify "mensagem"                     notificação do sistema

Notas
  palco note create ["conteúdo"] [--name N] [--stack F] [--color C]
  palco note read "Nota" [início] [qtd]  |  write "Nota" "conteúdo"  |  edit "Nota" "velho" "novo"
  palco note stack "Nota" "Fichário"  |  unstack "Nota"  |  delete "Nota"  |  delete --stack "Fichário"

Equipe
  palco recruit "Nome" [--preset P] [--role R] [--floor F] [--workspace W] [--band B] [--dir D] [--command C] [--replace "Antigo"]
  palco dismiss "Nome"   |   palco connect "A" "B"   |   palco arrange "Nome" [--name N] [--icon I] [--color C]
  palco band create "Band" ["Agente"...] [--without-me]  |  add "Band" "Agente"  |  remove "Band" "Agente"  |  dissolve "Band"
  palco role list | show | create "Nome" "Prompt" [--scope current|global] | edit "Nome" "velho" "novo" | write | assign "Agente" "Role"|--none | delete
  palco preset list | show | create "Nome" --command C | set "Nome" [--name] [--command] [--chat on|off] [--maestro on|off] [--quick-start on|off] | delete
  palco partitura list | insert "Nome" [--floor F] | create "Nome" ["Agente"...] | delete "Nome"

Andares e workspaces
  palco floor list | create "Nome" [--branch B] [--from REF] [--existing-branch] [--copy] [--no-git] [--dir D] [--pull-request N]
  palco floor land "Nome" [--into B] [--delete-branch] [--keep-floor] | delete "Nome" [--keep-branch] [--keep-folder] [--force]
  palco floor status ["texto"] [--state working|blocked|review|done] [--progress 2/5] [--floor F] [--clear]
  palco floor set-dir "Nome" PATH | unload "Nome"
  palco workspace list | create "Nome" --dir PATH [--from "Outro"] | rename "Atual" "Novo" | unload "Nome"

Routines
  palco routine list | show "Nome" | run "Nome" | enable "Nome" | disable "Nome" | delete "Nome"
  palco routine create "Nome" --command "..." (--every 10m | --at 09:00 | --cron "*/5 * * * *" | --once 2026-12-01T09:00)
                       [--target "Agente"] [--prompt] [--reminder] [--no-skip-if-busy]
  palco routine edit "Nome" [--name N] [--command C] [agenda] [--target T]

Portais (navegador)
  palco portal create "Nome" "url"    (cria e conecta a você)
  palco portal <sub> "Portal" ...     sub: info navigate back forward reload snapshot click hover focus check fill type
                                       select upload key selectall scroll scrollintoview text html evaluate screenshot
                                       resize ua logs logs-start clear

Serviço
  palco            abre o Palco no navegador (sobe o serviço se preciso)
  palco status | start | stop | restart | logs | install | uninstall | doctor | debug
`;

export interface Ctx {
  callerId?: string;
  stdin?: string;
}

export class Commands {
  constructor(private core: Core, private floors: Floors, private routines: Routines, private portals: Portals) {}

  private caller(ctx: Ctx) {
    if (!ctx.callerId) throw new PalcoError('Este comando só funciona dentro de um terminal do Palco (PALCO_TERMINAL_ID ausente).');
    const hit = this.core.locate(ctx.callerId);
    return hit as { ws: Workspace; node: PalcoNode<TerminalData> };
  }

  private ctxWs(ctx: Ctx) {
    if (ctx.callerId) return this.core.locate(ctx.callerId).ws;
    const first = this.core.store.orderedWorkspaces()[0];
    if (!first) throw new PalcoError('Nenhum workspace.');
    return first;
  }

  async run(argv: string[], ctx: Ctx): Promise<string> {
    const [cmd, ...rest] = argv;
    const p = parseArgs(rest);
    if (!cmd || cmd === 'help' || cmd === '--help') return HELP;
    switch (cmd) {
      case 'list': return this.list(ctx);
      case 'ask': return this.ask(p, ctx);
      case 'check': return this.check(p, ctx);
      case 'say': return this.say(p, ctx);
      case 'notify': this.core.notify(p.pos.join(' ') || ctx.stdin || ''); return 'Notificação enviada.';
      case 'note': return this.note(p, ctx);
      case 'recruit': return this.recruit(p, ctx);
      case 'dismiss': return this.dismiss(p, ctx);
      case 'connect': return this.connect(p, ctx);
      case 'arrange': return this.arrange(p, ctx);
      case 'band': return this.band(p, ctx);
      case 'role': return this.role(p, ctx);
      case 'preset': return this.preset(p);
      case 'partitura': return this.partitura(p, ctx);
      case 'floor': return this.floor(p, ctx);
      case 'workspace': return this.workspace(p, ctx);
      case 'routine': return this.routine(p, ctx);
      case 'portal': return this.portal(p, ctx);
      case 'debug': return this.debug(ctx);
      default: throw new PalcoError(`Comando desconhecido: ${cmd}\n\n${HELP}`);
    }
  }

  // ------------------------------------------------------------------ list
  list(ctx: Ctx) {
    const { ws, node } = this.caller(ctx);
    const r = this.core.reach(node.id);
    const floor = ws.floors.find((f) => f.id === node.floorId);
    const st = (n: PalcoNode) => this.core.sessions.get(n.id)?.status ?? 'parado';
    const role = (n: PalcoNode<TerminalData>) => {
      const rr = n.data.roleId ? this.core.sessions.findRole(this.core.locate(n.id).ws, n.data.roleId) : undefined;
      return rr ? ` — role: ${rr.name}` : '';
    };
    const lines = [`You: ${nameOf(node)}  (workspace: ${ws.name}, andar: ${floor?.name ?? '?'})`];
    const myBand = this.core.bandOf(node.id);
    lines.push('', 'Agentes:');
    if (!r.agents.length) lines.push('  (nenhum — recrute com `palco recruit` ou conecte no canvas)');
    for (const a of r.agents) {
      const aws = this.core.locate(a.id).ws;
      const fl = aws.floors.find((f) => f.id === a.floorId);
      const where = aws.id !== ws.id ? '' : fl && fl.id !== node.floorId ? ` [andar ${fl.name}]` : '';
      lines.push(`  - ${this.core.displayName(a, ws)} (${a.data.agentType}, ${st(a)})${where}${role(a)}`);
    }
    if (r.bands.length) {
      lines.push('', 'Bands:');
      for (const b of r.bands) lines.push(`  - ${nameOf(b)}${b.id === myBand?.id ? ' (você está nela)' : ''}: ${b.data.members.map((m) => nameOf(this.core.nodeById(m)!)).join(', ')}`);
    }
    lines.push('', 'Notas:');
    if (!r.notes.length) lines.push('  (nenhuma)');
    for (const { node: n, depth } of r.notes) {
      const tags = [n.data.stack ? `fichário: ${n.data.stack}` : '', n.data.locked ? 'locked: true' : ''].filter(Boolean).join(', ');
      lines.push(`  ${'  '.repeat(depth)}- ${nameOf(n)}${tags ? ` (${tags})` : ''}`);
    }
    lines.push('', 'Portais:');
    if (!r.portals.length) lines.push('  (nenhum)');
    for (const pt of r.portals) lines.push(`  - ${nameOf(pt)} → ${pt.data.url || 'about:blank'}`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------- messaging
  async ask(p: Parsed, ctx: Ctx) {
    const timeoutMs = parseDuration(str(p.flags.timeout)) ?? 10 * 60_000;
    if (p.flags.batch) {
      let map: Record<string, string>;
      try { map = JSON.parse(String(p.flags.batch)); } catch { throw new PalcoError('--batch precisa de um JSON {"Agente": "prompt"}'); }
      const results = await Promise.all(Object.entries(map).map(async ([name, prompt]) => {
        try { return { name, output: await this.core.ask(ctx.callerId, name, prompt, { timeoutMs }) }; }
        catch (e) { return { name, error: (e as Error).message }; }
      }));
      return JSON.stringify(results, null, 2);
    }
    const [name, ...textParts] = p.pos;
    const text = textParts.join(' ') || ctx.stdin || '';
    if (!name || !text) throw new PalcoError('Uso: palco ask "Nome" "prompt"');
    return this.core.ask(ctx.callerId, name, text, { raw: !!p.flags.raw, timeoutMs });
  }

  check(p: Parsed, ctx: Ctx) {
    const name = p.pos[0];
    if (!name) throw new PalcoError('Uso: palco check "Nome"');
    const { node } = this.core.reachable(ctx.callerId, name, ['terminal']);
    const s = this.core.sessions.get(node.id);
    if (!s) return `${nameOf(node)} está parado (o próximo ask acorda).`;
    return `[${nameOf(node)} — ${s.status}]\n${s.tail(Number(str(p.flags.lines)) || 60)}`;
  }

  say(p: Parsed, ctx: Ctx) {
    const { ws, node } = this.caller(ctx);
    let text = p.pos.join(' ') || ctx.stdin || '';
    const attachments: string[] = [];
    const file = str(p.flags.file);
    if (file) {
      const f = path.resolve(file);
      if (!fs.existsSync(f)) throw new PalcoError(`Arquivo não existe: ${f}`);
      if (/\.(png|jpe?g|gif|webp|heic)$/i.test(f)) attachments.push(f);
      else text += (text ? '\n\n' : '') + fs.readFileSync(f, 'utf8');
    }
    const att = str(p.flags.attach);
    if (att) attachments.push(path.resolve(att));
    if (!text.trim() && !attachments.length) throw new PalcoError('Nada para dizer. Use: palco say "texto"');
    this.core.store.appendChat(ws.id, node.id, { from: 'agent', name: nameOf(node), text, attachments });
    return 'Resposta entregue no chat.';
  }

  // ----------------------------------------------------------------- notes
  note(p: Parsed, ctx: Ctx) {
    const [sub, ...args] = p.pos;
    const store = this.core.store;
    const resolveNote = (name: string) => this.core.reachable(ctx.callerId, name, ['note']) as { ws: Workspace; node: PalcoNode<NoteData> };
    switch (sub) {
      case 'create': {
        const { ws, node } = this.caller(ctx);
        const content = args.join(' ') || ctx.stdin || '';
        const name = str(p.flags.name) || firstLine(content) || 'Nota';
        const n = this.core.addNode<NoteData>(ws, 'note', { name, color: str(p.flags.color) || 'yellow', locked: false, preview: true, stack: str(p.flags.stack) }, { near: node, side: 'left' });
        store.writeNote(ws.id, n.id, content);
        this.core.connect(ws, node.id, n.id);
        return `Nota criada: "${n.data.name}"`;
      }
      case 'read': {
        const { ws, node } = resolveNote(args[0]);
        const lines = store.readNote(ws.id, node.id).split('\n');
        const start = Math.max(1, Number(args[1]) || 1);
        const count = Number(args[2]) || lines.length;
        return lines.slice(start - 1, start - 1 + count).map((l, i) => `${String(start + i).padStart(4)}  ${l}`).join('\n') || '(nota vazia)';
      }
      case 'write': case 'edit': {
        const { ws, node } = resolveNote(args[0]);
        if (node.data.locked) throw new PalcoError(`"${nameOf(node)}" está trancada (locked). Peça ao usuário para destrancar.`);
        if (sub === 'write') {
          store.writeNote(ws.id, node.id, args.slice(1).join(' ') || ctx.stdin || '');
          return `"${nameOf(node)}" reescrita.`;
        }
        const cur = store.readNote(ws.id, node.id);
        const [oldT, newT] = [args[1], args[2] ?? ''];
        if (!oldT) throw new PalcoError('Uso: palco note edit "Nota" "texto velho" "texto novo"');
        const count = cur.split(oldT).length - 1;
        if (count === 0) throw new PalcoError('Texto velho não encontrado na nota. Rode `palco note read` e copie exatamente.');
        if (count > 1) throw new PalcoError(`O texto aparece ${count} vezes; inclua mais contexto para ficar único.`);
        store.writeNote(ws.id, node.id, cur.replace(oldT, newT));
        return `"${nameOf(node)}" editada.`;
      }
      case 'stack': case 'unstack': {
        const { ws, node } = resolveNote(args[0]);
        this.core.updateNode(ws, node.id, { data: { stack: sub === 'stack' ? args[1] : undefined } });
        return sub === 'stack' ? `"${nameOf(node)}" agora no fichário "${args[1]}".` : `"${nameOf(node)}" fora do fichário.`;
      }
      case 'delete': {
        if (p.flags.stack) {
          const stackName = str(p.flags.stack) ?? args[0];
          const { ws, node: me } = this.caller(ctx);
          const notes = this.core.reach(me.id).notes.filter((x) => x.node.data.stack === stackName);
          if (!notes.length) throw new PalcoError(`Fichário "${stackName}" não encontrado entre suas notas.`);
          for (const { node } of notes) this.core.removeNode(ws, node.id);
          return `Fichário "${stackName}" apagado (${notes.length} notas).`;
        }
        const { ws, node } = resolveNote(args[0]);
        this.core.removeNode(ws, node.id);
        return `Nota "${nameOf(node)}" apagada.`;
      }
      default: throw new PalcoError('Uso: palco note create|read|write|edit|stack|unstack|delete');
    }
  }

  // ------------------------------------------------------------------ team
  private preset(p: Parsed): string;
  private preset(p: Parsed, find: string): Preset;
  private preset(p: Parsed, find?: string): string | Preset {
    const cfg = this.core.store.config;
    const byName = (n: string) => {
      const x = cfg.presets.find((pp) => pp.name.toLowerCase() === n.toLowerCase());
      if (!x) throw new PalcoError(`Preset "${n}" não existe. Veja: palco preset list`);
      return x;
    };
    if (find !== undefined) return byName(find);
    const [sub, name] = p.pos;
    const show = (x: Preset) => `${x.name}: ${x.command || '(shell)'}  [${x.agentType}${x.chat ? ', chat' : ''}${x.maestro ? ', maestro' : ''}${x.quickStart ? ', quick-start' : ''}]`;
    const onoff = (v: string | true | undefined) => (v === undefined ? undefined : v === 'on' || v === true);
    switch (sub) {
      case undefined: case 'list': return cfg.presets.map(show).join('\n');
      case 'show': return show(byName(name));
      case 'create': {
        if (!name) throw new PalcoError('Uso: palco preset create "Nome" --command "..."');
        if (cfg.presets.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new PalcoError('Já existe.');
        const command = str(p.flags.command) ?? '';
        const x: Preset = { id: uid(), name, command, agentType: guessType(command), chat: false, quickStart: true, maestro: false, color: randomColor() };
        cfg.presets.push(x);
        this.core.store.saveConfig();
        return show(x);
      }
      case 'set': {
        const x = byName(name);
        if (str(p.flags.name)) x.name = str(p.flags.name)!;
        if (p.flags.command !== undefined) { x.command = str(p.flags.command) ?? ''; x.agentType = guessType(x.command); }
        const chat = onoff(p.flags.chat), maestro = onoff(p.flags.maestro), qs = onoff(p.flags['quick-start']);
        if (chat !== undefined) x.chat = chat;
        if (maestro !== undefined) x.maestro = maestro;
        if (qs !== undefined) x.quickStart = qs;
        this.core.store.saveConfig();
        return show(x);
      }
      case 'delete': {
        const x = byName(name);
        cfg.presets = cfg.presets.filter((y) => y !== x);
        this.core.store.saveConfig();
        return `Preset "${x.name}" apagado.`;
      }
      default: throw new PalcoError('Uso: palco preset list|show|create|set|delete');
    }
  }

  private findRole(ws: Workspace, name: string): Role {
    const r = ws.roles.find((x) => x.name.toLowerCase() === name.toLowerCase())
      || this.core.store.config.roles.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new PalcoError(`Role "${name}" não existe. Veja: palco role list`);
    return r;
  }

  async recruit(p: Parsed, ctx: Ctx) {
    const me = ctx.callerId ? this.caller(ctx) : undefined;
    let ws = me?.ws ?? this.ctxWs(ctx);
    if (str(p.flags.workspace)) ws = this.core.wsByName(str(p.flags.workspace)!);
    const floor = this.core.floorByName(ws, str(p.flags.floor))
      ?? (me && ws.id === me.ws.id ? ws.floors.find((f) => f.id === me.node.floorId) : undefined)
      ?? this.core.groundOf(ws);
    if (p.flags.account) throw new PalcoError('--account ainda não é suportado no Palco; use --command com as variáveis de ambiente da conta.');
    const role = str(p.flags.role) ? this.findRole(ws, str(p.flags.role)!) : undefined;
    const preset = str(p.flags.preset) ? this.preset(p, str(p.flags.preset)!) : undefined;
    const cmd = str(p.flags.command);

    if (p.flags.replace) {
      const { ws: tws, node } = this.core.reachable(ctx.callerId, String(p.flags.replace), ['terminal']) as { ws: Workspace; node: PalcoNode<TerminalData> };
      if (!preset && cmd === undefined && !role && !p.pos[0] && !p.flags.dir) throw new PalcoError('--replace precisa de --preset, --command, --role, --dir ou um nome novo.');
      const patch: Partial<TerminalData> = {};
      if (preset) Object.assign(patch, { command: preset.command, agentType: preset.agentType, presetId: preset.id, color: preset.color });
      if (cmd !== undefined) Object.assign(patch, { command: cmd, agentType: guessType(cmd) });
      if (role) patch.roleId = role.id;
      if (str(p.flags.dir)) patch.cwd = path.resolve(str(p.flags.dir)!);
      if (p.pos[0]) patch.name = p.pos[0];
      this.core.updateNode(tws, node.id, { data: patch as Record<string, unknown> });
      this.core.sessions.start(tws, node);
      return `${nameOf(node)} reiniciado com ${node.data.command || 'shell'}${role ? ` (role ${role.name})` : ''}. O histórico do chat não sobrevive; reapresente a tarefa com palco ask.`;
    }

    const myPreset = me?.node.data.presetId ? this.core.store.config.presets.find((x) => x.id === me.node.data.presetId) : undefined;
    const data = this.core.newTerminalData(ws, {
      name: p.pos[0] || role?.name || 'Recruta',
      preset: preset ?? (cmd === undefined ? myPreset : undefined),
      command: cmd ?? (preset || myPreset ? undefined : me?.node.data.command),
      cwd: str(p.flags.dir) ? path.resolve(str(p.flags.dir)!) : floor.id !== me?.node.floorId || ws.id !== me?.ws.id ? floor.dir : me?.node.data.cwd,
      floorId: floor.id,
      roleId: role?.id,
      color: str(p.flags.color),
      icon: str(p.flags.icon),
    });
    const near = me && me.node.floorId === floor.id && me.ws.id === ws.id ? me.node : undefined;
    const node = this.core.addNode<TerminalData>(ws, 'terminal', data, { floorId: floor.id, near });
    let how = '';
    const bandName = str(p.flags.band);
    const myBand = me ? this.core.bandOf(me.node.id) : undefined;
    if (bandName) {
      const { node: b } = this.core.byName(bandName, ws, ['band']);
      (b.data as BandData).members.push(node.id);
      this.core.store.touch(ws);
      how = ` na band ${nameOf(b)}`;
    } else if (myBand && myBand.floorId === floor.id && me && ws.id === me.ws.id) {
      myBand.data.members.push(node.id);
      this.core.store.touch(ws);
      how = ` na sua band ${nameOf(myBand)}`;
    } else if (me) {
      this.core.connect(me.ws, me.node.id, node.id);
      how = ', conectado a você';
    }
    const addr = me ? this.core.displayName(node, me.ws) : nameOf(node);
    return `Recrutado "${addr}"${how} (${data.command || 'shell'}${role ? `, role ${role.name}` : ''}, andar ${floor.name}). Dê alguns segundos para o agente iniciar antes do primeiro ask.`;
  }

  dismiss(p: Parsed, ctx: Ctx) {
    const { ws, node } = this.core.reachable(ctx.callerId, p.pos[0] ?? '', ['terminal']);
    if (node.id === ctx.callerId) throw new PalcoError('Você não pode se dispensar.');
    this.core.removeNode(ws, node.id);
    return `${nameOf(node)} dispensado.`;
  }

  connect(p: Parsed, ctx: Ctx) {
    const [a, b] = p.pos;
    if (!a || !b) throw new PalcoError('Uso: palco connect "De" "Para"');
    const A = this.core.reachable(ctx.callerId, a, ['terminal', 'note', 'portal', 'band']);
    const B = this.core.reachable(ctx.callerId, b, ['terminal', 'note', 'portal', 'band']);
    this.core.connect(A.ws, A.node.id, B.node.id);
    return `Conectado: ${nameOf(A.node)} ↔ ${nameOf(B.node)}`;
  }

  arrange(p: Parsed, ctx: Ctx) {
    if (!p.pos[0]) {
      return 'Cores: qualquer hex (#4f9dde) ou yellow, blue, green, pink, purple, orange, gray.\nÍcones: emoji ou palavra curta (ex.: 🦉, ⚙️, review).';
    }
    const { ws, node } = this.core.reachable(ctx.callerId, p.pos[0], ['terminal', 'note', 'portal', 'band']);
    const patch: Record<string, unknown> = {};
    if (str(p.flags.name)) patch.name = str(p.flags.name);
    if (str(p.flags.icon)) patch.icon = str(p.flags.icon);
    if (str(p.flags.color)) patch.color = str(p.flags.color);
    if (!Object.keys(patch).length) return `${nameOf(node)}: cor ${(node.data as { color?: string }).color ?? '-'}, ícone ${(node.data as { icon?: string }).icon ?? '-'}`;
    this.core.updateNode(ws, node.id, { data: patch });
    return `Atualizado: ${nameOf(node)}`;
  }

  band(p: Parsed, ctx: Ctx) {
    const [sub, name, ...names] = p.pos;
    const me = this.caller(ctx);
    let ws = me.ws;
    if (str(p.flags.workspace)) ws = this.core.wsByName(str(p.flags.workspace)!);
    switch (sub) {
      case 'create': {
        if (!name) throw new PalcoError('Uso: palco band create "Nome" ["Agente"...]');
        const floor = this.core.floorByName(ws, str(p.flags.floor)) ?? ws.floors.find((f) => f.id === me.node.floorId) ?? this.core.groundOf(ws);
        let members: string[];
        if (names.length) members = names.map((n) => this.core.reachable(ctx.callerId, n, ['terminal']).node.id);
        else members = this.core.reach(me.node.id).agents.filter((a) => a.floorId === floor.id).map((a) => a.id);
        if (!p.flags['without-me'] && floor.id === me.node.floorId && ws.id === me.ws.id) members.unshift(me.node.id);
        members = [...new Set(members)].filter((m) => !this.core.bandOf(m));
        if (members.length < 2) throw new PalcoError('Uma band precisa de pelo menos dois agentes livres (fora de outra band).');
        const near = this.core.nodeById(members[0]);
        const b = this.core.addNode<BandData>(ws, 'band', { name, members, color: str(p.flags.color) || randomColor(), icon: str(p.flags.icon) }, { floorId: floor.id, near, side: 'left' });
        if (p.flags['without-me'] || floor.id !== me.node.floorId) this.core.connect(ws, me.node.id, b.id);
        return `Band "${b.data.name}" criada: ${members.map((m) => nameOf(this.core.nodeById(m)!)).join(', ')}`;
      }
      case 'add': case 'remove': {
        const { ws: bws, node: b } = this.core.reachable(ctx.callerId, name ?? '', ['band']) as { ws: Workspace; node: PalcoNode<BandData> };
        const agent = this.core.reachable(ctx.callerId, names[0] ?? '', ['terminal']).node;
        if (sub === 'add') {
          if (this.core.bandOf(agent.id)) throw new PalcoError(`${nameOf(agent)} já está em uma band.`);
          b.data.members.push(agent.id);
        } else {
          b.data.members = b.data.members.filter((m) => m !== agent.id);
        }
        this.core.store.touch(bws);
        if (b.data.members.length < 2) { this.core.removeNode(bws, b.id); return `Band "${b.data.name}" dissolvida (ficou com um membro).`; }
        return `${nameOf(agent)} ${sub === 'add' ? 'entrou na' : 'saiu da'} band ${b.data.name}.`;
      }
      case 'dissolve': {
        const { ws: bws, node: b } = this.core.reachable(ctx.callerId, name ?? '', ['band']);
        this.core.removeNode(bws, b.id);
        return `Band "${nameOf(b)}" dissolvida; os membros seguem rodando.`;
      }
      default: throw new PalcoError('Uso: palco band create|add|remove|dissolve');
    }
  }

  role(p: Parsed, ctx: Ctx) {
    const ws = ctx.callerId ? this.core.locate(ctx.callerId).ws : this.ctxWs(ctx);
    const [sub, name, a2, a3] = p.pos;
    const cfg = this.core.store.config;
    const save = (r: Role) => { if (r.scope === 'global') this.core.store.saveConfig(); else this.core.store.touch(ws); };
    switch (sub) {
      case undefined: case 'list': {
        const fmt = (r: Role) => `  - ${r.name}: ${r.prompt.replace(/\s+/g, ' ').slice(0, 90)}${r.prompt.length > 90 ? '…' : ''}`;
        return [`Current workspace (${ws.name}):`, ...(ws.roles.length ? ws.roles.map(fmt) : ['  (nenhuma)']), 'Global:', ...(cfg.roles.length ? cfg.roles.map(fmt) : ['  (nenhuma)'])].join('\n');
      }
      case 'show': return this.findRole(ws, name).prompt;
      case 'create': {
        if (!name || !a2) throw new PalcoError('Uso: palco role create "Nome" "Prompt" [--scope current|global]');
        if ([...ws.roles, ...cfg.roles].some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new PalcoError('Já existe uma role com esse nome.');
        const r: Role = { id: uid(), name, prompt: a2, scope: p.flags.scope === 'global' ? 'global' : 'workspace' };
        (r.scope === 'global' ? cfg.roles : ws.roles).push(r);
        save(r);
        return `Role "${name}" criada (${r.scope === 'global' ? 'global' : 'deste workspace'}).`;
      }
      case 'edit': case 'write': {
        const r = this.findRole(ws, name);
        if (sub === 'write') r.prompt = a2 ?? '';
        else if (a2 !== undefined) {
          if (!r.prompt.includes(a2)) throw new PalcoError('Texto não encontrado no prompt da role.');
          r.prompt = r.prompt.replace(a2, a3 ?? '');
        }
        if (p.flags.scope) {
          const target = p.flags.scope === 'global' ? 'global' : 'workspace';
          if (target !== r.scope) {
            ws.roles = ws.roles.filter((x) => x !== r);
            cfg.roles = cfg.roles.filter((x) => x !== r);
            r.scope = target;
            (target === 'global' ? cfg.roles : ws.roles).push(r);
            this.core.store.saveConfig();
            this.core.store.touch(ws);
          }
        }
        save(r);
        return `Role "${r.name}" atualizada. Agentes com ela pegam o texto novo ao reiniciar (palco role assign).`;
      }
      case 'assign': {
        const { ws: tws, node } = this.core.reachable(ctx.callerId, name ?? '', ['terminal']) as { ws: Workspace; node: PalcoNode<TerminalData> };
        const r = p.flags.none ? undefined : this.findRole(ws, a2 ?? '');
        this.core.updateNode(tws, node.id, { data: { roleId: r?.id } });
        this.core.sessions.start(tws, node);
        return `${nameOf(node)} reiniciado ${r ? `com a role ${r.name}` : 'sem role'}.`;
      }
      case 'delete': {
        const r = this.findRole(ws, name);
        ws.roles = ws.roles.filter((x) => x !== r);
        cfg.roles = cfg.roles.filter((x) => x !== r);
        this.core.store.saveConfig();
        this.core.store.touch(ws);
        return `Role "${r.name}" apagada.`;
      }
      default: throw new PalcoError('Uso: palco role list|show|create|edit|write|assign|delete');
    }
  }

  partitura(p: Parsed, ctx: Ctx) {
    const cfg = this.core.store.config;
    const [sub, name, ...names] = p.pos;
    const find = (n: string) => {
      const x = cfg.partituras.find((y) => y.name.toLowerCase() === n.toLowerCase());
      if (!x) throw new PalcoError(`Partitura "${n}" não existe.`);
      return x;
    };
    switch (sub) {
      case undefined: case 'list':
        return cfg.partituras.map((x) => `- ${x.name}: ${x.items.filter((i) => i.type === 'terminal').length} agentes, ${x.items.filter((i) => i.type === 'note').length} notas`).join('\n') || '(nenhuma partitura salva)';
      case 'create': case 'update': {
        const me = this.caller(ctx);
        if (!name) throw new PalcoError('Uso: palco partitura create "Nome" ["Agente"...]');
        const ids = new Set<string>([me.node.id]);
        const r = this.core.reach(me.node.id);
        const agents = names.length ? names.map((n) => this.core.reachable(ctx.callerId, n, ['terminal']).node) : r.agents.filter((a) => a.floorId === me.node.floorId);
        agents.forEach((a) => ids.add(a.id));
        r.notes.forEach((n) => ids.add(n.node.id));
        r.bands.forEach((b) => { if (b.floorId === me.node.floorId) ids.add(b.id); });
        const nodes = me.ws.nodes.filter((n) => ids.has(n.id));
        const ox = Math.min(...nodes.map((n) => n.x)), oy = Math.min(...nodes.map((n) => n.y));
        const part: Partitura = {
          id: uid(), name, createdAt: now(),
          items: nodes.map((n) => ({ ref: n.id, type: n.type, dx: n.x - ox, dy: n.y - oy, w: n.w, h: n.h, data: structuredClone(n.data), note: n.type === 'note' ? this.core.store.readNote(me.ws.id, n.id) : undefined })),
          edges: me.ws.edges.filter((e) => ids.has(e.a) && ids.has(e.b)).map((e) => [e.a, e.b]),
        };
        cfg.partituras = cfg.partituras.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
        cfg.partituras.push(part);
        this.core.store.saveConfig();
        return `Partitura "${name}" salva com ${part.items.length} itens.`;
      }
      case 'insert': {
        const part = find(name ?? '');
        const me = ctx.callerId ? this.caller(ctx) : undefined;
        const ws = me?.ws ?? this.ctxWs(ctx);
        const floor = this.core.floorByName(ws, str(p.flags.floor)) ?? (me ? ws.floors.find((f) => f.id === me.node.floorId)! : this.core.groundOf(ws));
        const maxX = Math.max(0, ...ws.nodes.filter((n) => n.floorId === floor.id).map((n) => n.x + n.w));
        const map = new Map<string, string>();
        const created: PalcoNode[] = [];
        for (const it of part.items) {
          const data = structuredClone(it.data) as Record<string, unknown>;
          if (it.type === 'terminal') data.cwd = floor.dir;
          if (it.type === 'band') data.members = [];
          const n = this.core.addNode(ws, it.type, data, { floorId: floor.id, x: maxX + 150 + it.dx, y: it.dy, w: it.w, h: it.h });
          map.set(it.ref, n.id);
          created.push(n);
          if (it.type === 'note') this.core.store.writeNote(ws.id, n.id, it.note ?? '');
        }
        for (const it of part.items) {
          if (it.type === 'band') {
            const b = ws.nodes.find((n) => n.id === map.get(it.ref))!;
            (b.data as BandData).members = ((it.data as BandData).members ?? []).map((m) => map.get(m)).filter(Boolean) as string[];
          }
        }
        for (const [a, b] of part.edges) if (map.get(a) && map.get(b)) this.core.connect(ws, map.get(a)!, map.get(b)!);
        const agents = created.filter((n) => n.type === 'terminal') as PalcoNode<TerminalData>[];
        if (me) {
          const maestros = agents.filter((a) => a.data.maestro);
          for (const a of maestros.length ? maestros : agents) this.core.connect(ws, me.node.id, a.id);
        }
        this.core.store.touch(ws);
        return `Partitura "${part.name}" colocada. Agentes: ${agents.map((a) => nameOf(a)).join(', ') || '(nenhum)'}`;
      }
      case 'delete': {
        const part = find(name ?? '');
        cfg.partituras = cfg.partituras.filter((x) => x !== part);
        this.core.store.saveConfig();
        return `Partitura "${part.name}" apagada.`;
      }
      default: throw new PalcoError('Uso: palco partitura list|insert|create|update|delete');
    }
  }

  // ---------------------------------------------------------------- floors
  async floor(p: Parsed, ctx: Ctx) {
    const me = ctx.callerId ? this.caller(ctx) : undefined;
    const ws = me?.ws ?? this.ctxWs(ctx);
    const [sub, name, dir] = p.pos;
    switch (sub) {
      case undefined: case 'list':
        return this.floors.list(ws).map((f) => {
          const st = f.status ? ` — ${[f.status.state, f.status.progress, f.status.text].filter(Boolean).join(' · ')}` : '';
          return `- ${f.name}${f.ground ? ' (térreo)' : ''}${f.branch ? ` [${f.branch}]` : ''}${f.unloaded ? ' (descarregado)' : ''}: ${f.agents} agentes, ${f.dir}${st}`;
        }).join('\n');
      case 'create': {
        const { floor, note } = await this.floors.create(ws, name || `Andar ${ws.floors.length}`, {
          branch: str(p.flags.branch), from: str(p.flags.from), existingBranch: !!p.flags['existing-branch'], copy: !!p.flags.copy,
          noGit: !!p.flags['no-git'], dir: str(p.flags.dir), pullRequest: str(p.flags['pull-request']),
        });
        let extra = '';
        if (p.flags['copy-ground']) {
          const ground = this.core.groundOf(ws);
          const terms = ws.nodes.filter((n) => n.floorId === ground.id && n.type === 'terminal') as PalcoNode<TerminalData>[];
          for (const t of terms) this.core.addNode<TerminalData>(ws, 'terminal', { ...structuredClone(t.data), cwd: floor.dir }, { floorId: floor.id, x: t.x, y: t.y, w: t.w, h: t.h });
          extra = ` ${terms.length} terminais copiados do térreo.`;
        }
        if (str(p.flags.partitura)) extra += ' ' + this.partitura({ pos: ['insert', str(p.flags.partitura)!], flags: { floor: floor.name } }, ctx);
        return `Andar "${floor.name}" criado. ${note}${extra}`;
      }
      case 'delete': return this.floors.remove(ws, name, { keepBranch: !!p.flags['keep-branch'], keepFolder: !!p.flags['keep-folder'], force: !!p.flags.force });
      case 'land': return this.floors.land(ws, name, { into: str(p.flags.into), deleteBranch: !!p.flags['delete-branch'], keepFloor: !!p.flags['keep-floor'] });
      case 'status': return this.floors.status(ws, str(p.flags.floor), me?.node.floorId, name, { state: str(p.flags.state) as never, progress: str(p.flags.progress), clear: !!p.flags.clear });
      case 'set-dir': return this.floors.setDir(ws, name, path.resolve(dir ?? ''));
      case 'unload': return this.floors.unload(ws, name);
      default: throw new PalcoError('Uso: palco floor list|create|delete|land|status|set-dir|unload');
    }
  }

  workspace(p: Parsed, ctx: Ctx) {
    const store = this.core.store;
    const [sub, name, newName] = p.pos;
    switch (sub) {
      case undefined: case 'list':
        return store.orderedWorkspaces().map((w) => `- ${w.name}: ${w.dir} (${w.nodes.filter((n) => n.type === 'terminal').length} agentes, ${w.floors.length} andares)${w.unloaded ? ' (descarregado)' : ''}`).join('\n');
      case 'create': {
        const dir = str(p.flags.dir);
        if (!name || !dir) throw new PalcoError('Uso: palco workspace create "Nome" --dir PATH [--from "Outro"]');
        const abs = path.resolve(dir);
        fs.mkdirSync(abs, { recursive: true });
        const ws = store.createWorkspace(name, abs);
        const from = str(p.flags.from);
        if (from) {
          const src = this.core.wsByName(from);
          ws.roles = structuredClone(src.roles);
          const ground = this.core.groundOf(ws);
          const srcGround = this.core.groundOf(src);
          const map = new Map<string, string>();
          for (const n of src.nodes.filter((x) => x.floorId === srcGround.id && x.type !== 'portal')) {
            const data = structuredClone(n.data) as Record<string, unknown>;
            if (n.type === 'terminal') data.cwd = abs;
            const c = this.core.addNode(ws, n.type, data, { floorId: ground.id, x: n.x, y: n.y, w: n.w, h: n.h });
            map.set(n.id, c.id);
            if (n.type === 'note') store.writeNote(ws.id, c.id, store.readNote(src.id, n.id));
          }
          for (const e of src.edges) if (map.has(e.a) && map.has(e.b)) this.core.connect(ws, map.get(e.a)!, map.get(e.b)!);
        }
        void ctx;
        return `Workspace "${ws.name}" criado em ${abs}.`;
      }
      case 'rename': {
        const ws = this.core.wsByName(name ?? '');
        ws.name = store.uniqueWorkspaceName(newName ?? ws.name);
        store.touch(ws);
        return `Renomeado para "${ws.name}".`;
      }
      case 'unload': {
        const ws = this.core.wsByName(name ?? '');
        for (const n of ws.nodes.filter((x) => x.type === 'terminal')) this.core.sessions.stop(n.id, false);
        ws.unloaded = true;
        store.touch(ws);
        return `Workspace "${ws.name}" descarregado.`;
      }
      default: throw new PalcoError('Uso: palco workspace list|create|rename|unload');
    }
  }

  // -------------------------------------------------------------- routines
  async routine(p: Parsed, ctx: Ctx) {
    const ws = ctx.callerId ? this.core.locate(ctx.callerId).ws : this.ctxWs(ctx);
    const [sub, name] = p.pos;
    const schedule = () => {
      const s: Routine['schedule'] = {};
      if (str(p.flags.every)) s.every = str(p.flags.every);
      if (str(p.flags.at)) s.at = str(p.flags.at);
      if (str(p.flags.cron)) s.cron = str(p.flags.cron);
      if (str(p.flags.once)) s.once = str(p.flags.once);
      return Object.keys(s).length ? s : undefined;
    };
    const show = (r: Routine) => `- ${r.name}${r.enabled ? '' : ' (desligada)'}: ${r.kind} ${r.target ? `→ ${r.target} ` : ''}${describeSchedule(r.schedule)}\n    ${r.command}\n    próxima: ${this.routines.nextRun(r) ?? '-'} | última: ${r.lastRunAt ?? '-'} ${r.lastResult ? `(${r.lastResult})` : ''}`;
    switch (sub) {
      case undefined: case 'list': return ws.routines.map(show).join('\n') || '(nenhuma routine)';
      case 'show': return show(this.routines.find(ws, name ?? ''));
      case 'create': {
        const sched = schedule();
        if (!sched) throw new PalcoError('Informe a agenda: --every 10m | --at 09:00 | --cron "..." | --once 2026-12-01T09:00');
        const kind: Routine['kind'] = p.flags.reminder ? 'reminder' : p.flags.prompt ? 'prompt' : 'command';
        let target = str(p.flags.target);
        if (!target && kind !== 'reminder' && ctx.callerId) target = nameOf(this.core.locate(ctx.callerId).node);
        const r = this.routines.create(ws, {
          name: name ?? '', kind, target, command: str(p.flags.command) ?? '', schedule: sched, enabled: true,
          skipIfBusy: !p.flags['no-skip-if-busy'],
        });
        return `Routine criada.\n${show(r)}`;
      }
      case 'edit': {
        const patch: Partial<Routine> = {};
        if (str(p.flags.name)) patch.name = str(p.flags.name);
        if (str(p.flags.command)) patch.command = str(p.flags.command);
        if (str(p.flags.target)) patch.target = str(p.flags.target);
        if (schedule()) patch.schedule = schedule();
        if (p.flags['no-skip-if-busy']) patch.skipIfBusy = false;
        if (p.flags['skip-if-busy']) patch.skipIfBusy = true;
        return `Atualizada.\n${show(this.routines.update(ws, name ?? '', patch))}`;
      }
      case 'enable': case 'disable': return show(this.routines.update(ws, name ?? '', { enabled: sub === 'enable' }));
      case 'delete': this.routines.remove(ws, name ?? ''); return `Routine "${name}" apagada.`;
      case 'run': { const r = this.routines.find(ws, name ?? ''); return this.routines.run(ws.id, r.id, true); }
      default: throw new PalcoError('Uso: palco routine list|show|create|edit|enable|disable|delete|run');
    }
  }

  // --------------------------------------------------------------- portals
  async portal(p: Parsed, ctx: Ctx) {
    const [sub, name, ...args] = p.pos;
    if (!sub || p.flags.help) return HELP.split('Portais (navegador)')[1].split('Serviço')[0];
    if (sub === 'create' || sub === 'open') {
      const me = this.caller(ctx);
      if (!name) throw new PalcoError('Uso: palco portal create "Nome" "url"');
      const node = this.core.addNode<PortalData>(me.ws, 'portal', { name, url: args[0] ?? 'about:blank', viewport: { width: 1280, height: 800 } }, { near: me.node });
      this.core.connect(me.ws, me.node.id, node.id);
      return `Portal "${node.data.name}" criado e conectado a você.${args[0] ? ' ' + (await this.portals.command(node.id, 'info', [])) : ''}`;
    }
    const { node } = this.core.reachable(ctx.callerId, name ?? '', ['portal']);
    const extra = [...args];
    if (p.flags.full) extra.push('--full');
    return this.portals.command(node.id, sub, extra);
  }

  debug(ctx: Ctx) {
    const lines = [`servidor: ok (${this.core.store.workspaces.size} workspaces, ${this.core.sessions.sessions.size} sessões)`];
    if (!ctx.callerId) lines.push('PALCO_TERMINAL_ID: ausente — você está fora de um terminal do Palco; comandos de agente não funcionam aqui.');
    else {
      const hit = this.core.store.findWorkspaceOfNode(ctx.callerId);
      lines.push(hit ? `você: ${nameOf(hit.node)} em ${hit.ws.name}` : `PALCO_TERMINAL_ID ${ctx.callerId} não corresponde a nenhum terminal (terminal removido?)`);
    }
    return lines.join('\n');
  }
}

function firstLine(s: string) {
  return s.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 40);
}

function guessType(command: string): TerminalData['agentType'] {
  const prog = command.trim().split(/\s+/).find((t) => !t.includes('='))?.split('/').pop() ?? '';
  return ({ claude: 'claude_code', codex: 'codex', opencode: 'opencode', gemini: 'gemini', '': 'shell' } as Record<string, TerminalData['agentType']>)[prog] ?? 'custom';
}

export function parseDuration(s?: string) {
  if (!s) return undefined;
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new PalcoError(`Duração inválida: ${s} (use 90s, 10m, 1h)`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']);
}
