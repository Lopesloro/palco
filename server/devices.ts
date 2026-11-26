import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { Core, PalcoError, nameOf } from './core.js';
import { callHelper } from './native.js';
import { SHOTS_DIR } from './paths.js';
import type { DeviceData, PalcoNode } from './types.js';

interface Run { stdout: Buffer; stderr: string }

function run(file: string, args: string[], timeout = 20_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) reject(new PalcoError(`${path.basename(file)} ${args[0] ?? ''}: ${String(stderr || err.message).trim()}`));
      else resolve({ stdout, stderr: String(stderr) });
    });
  });
}

export function findAdb(): string | undefined {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library', 'Android', 'sdk');
  const candidates = [path.join(sdk, 'platform-tools', 'adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb'];
  for (const dir of (process.env.PATH ?? '').split(':')) candidates.push(path.join(dir, 'adb'));
  return candidates.find((c) => fs.existsSync(c));
}

let simctlOk: boolean | undefined;
async function hasSimctl() {
  if (simctlOk !== undefined) return simctlOk;
  simctlOk = await run('xcrun', ['simctl', 'help'], 5000).then(() => true, () => false);
  return simctlOk;
}

export interface UiNode { ref: string; text: string; cls: string; id: string; clickable: boolean; x: number; y: number }

/** Parses `uiautomator dump` XML into addressable elements with their center points. */
export function parseUiautomator(xml: string): UiNode[] {
  const out: UiNode[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  const attr = (s: string, k: string) => s.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? '';
  const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const b = attr(a, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const text = unesc(attr(a, 'text') || attr(a, 'content-desc'));
    const clickable = attr(a, 'clickable') === 'true' || attr(a, 'checkable') === 'true' || attr(a, 'focusable') === 'true' && /EditText/.test(attr(a, 'class'));
    if (!text && !clickable) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ ref: `e${out.length + 1}`, text, cls: attr(a, 'class').split('.').pop() ?? '', id: attr(a, 'resource-id').split('/').pop() ?? '', clickable, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
  }
  return out;
}

/** Android escapes for `input text`: spaces become %s and shell metacharacters are quoted. */
export function adbText(s: string) {
  return s.replace(/ /g, '%s').replace(/(["'`\\$&|;<>()*?!#~])/g, '\\$1');
}

const ANDROID_KEYS: Record<string, number> = { home: 3, back: 4, enter: 66, tab: 61, delete: 67, backspace: 67, menu: 82, recents: 187, power: 26, up: 19, down: 20, left: 21, right: 22, volumeup: 24, volumedown: 25 };

/**
 * Device portals: an Android phone/emulator (adb) or an iOS Simulator (xcrun simctl) on the
 * canvas, streamed as screenshots, tappable by the human and drivable by agents.
 */
export class Devices extends EventEmitter {
  private watchers = new Map<string, { count: number; timer?: NodeJS.Timeout; busy: boolean }>();
  private uiCache = new Map<string, UiNode[]>();

  constructor(private core: Core) {
    super();
  }

  async status() {
    const adb = findAdb();
    const lines = [`adb: ${adb ?? 'não encontrado (brew install android-platform-tools)'}`];
    if (adb) {
      const { stdout } = await run(adb, ['devices', '-l']).catch(() => ({ stdout: Buffer.from('') }));
      const devs = String(stdout).split('\n').slice(1).filter((l) => l.trim());
      lines.push(...(devs.length ? devs.map((d) => `  android: ${d.trim()}`) : ['  (nenhum Android conectado)']));
    }
    if (await hasSimctl()) {
      const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
      const j = JSON.parse(String(stdout)) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
      const sims = Object.values(j.devices).flat();
      lines.push(`simctl: ok (${sims.filter((s) => s.state === 'Booted').length} ligado(s))`);
      for (const s of sims.filter((x) => x.state === 'Booted')) lines.push(`  ios: ${s.name} ${s.udid}`);
      if (!sims.some((s) => s.state === 'Booted')) lines.push(`  disponíveis: ${sims.slice(0, 6).map((s) => s.name).join(', ')}`);
    } else lines.push('simctl: indisponível (instale o Xcode completo para usar o Simulador iOS)');
    return lines.join('\n');
  }

  private node(id: string) {
    const { node } = this.core.locate(id);
    if (node.type !== 'device') throw new PalcoError(`${nameOf(node)} não é um dispositivo.`);
    return node as PalcoNode<DeviceData>;
  }

  private adb(d: DeviceData) {
    const adb = findAdb();
    if (!adb) throw new PalcoError('adb não encontrado. Instale com: brew install android-platform-tools');
    return (args: string[], timeout?: number) => run(adb, [...(d.deviceId ? ['-s', d.deviceId] : []), ...args], timeout);
  }

  private async simId(d: DeviceData) {
    if (!(await hasSimctl())) throw new PalcoError('O Simulador iOS precisa do Xcode completo (xcrun simctl). Instale pela App Store.');
    return d.deviceId || 'booted';
  }

  async screenshot(id: string): Promise<Buffer> {
    const d = this.node(id).data;
    if (d.platform === 'android') return (await this.adb(d)(['exec-out', 'screencap', '-p'])).stdout;
    const sim = await this.simId(d);
    const f = path.join(os.tmpdir(), `palco-sim-${process.pid}-${Date.now()}.png`);
    await run('xcrun', ['simctl', 'io', sim, 'screenshot', '--type=png', f]);
    try { return fs.readFileSync(f); } finally { fs.rmSync(f, { force: true }); }
  }

  watch(id: string) {
    const w = this.watchers.get(id) ?? { count: 0, busy: false };
    w.count++;
    this.watchers.set(id, w);
    if (w.timer) return;
    const tick = async () => {
      if (w.busy) return;
      w.busy = true;
      try {
        const png = await this.screenshot(id);
        this.emit('frame', id, png.toString('base64'), 'png');
      } catch (e) {
        this.emit('error', id, (e as Error).message);
        this.unwatch(id, true);
      } finally {
        w.busy = false;
      }
    };
    void tick();
    w.timer = setInterval(() => void tick(), 900);
  }

  unwatch(id: string, all = false) {
    const w = this.watchers.get(id);
    if (!w) return;
    w.count = all ? 0 : Math.max(0, w.count - 1);
    if (w.count === 0) {
      clearInterval(w.timer);
      this.watchers.delete(id);
    }
  }

  /** The human tapping the live view; x/y are device pixels. */
  async input(id: string, ev: { kind: string; x?: number; y?: number; x2?: number; y2?: number; text?: string; key?: string }) {
    const d = this.node(id).data;
    if (d.platform !== 'android') throw new PalcoError('No Simulador iOS, toque direto na janela do Simulador ou use `palco device snapshot/click` (via computer use).');
    const adb = this.adb(d);
    if (ev.kind === 'tap') await adb(['shell', 'input', 'tap', String(Math.round(ev.x!)), String(Math.round(ev.y!))]);
    else if (ev.kind === 'swipe') await adb(['shell', 'input', 'swipe', String(ev.x), String(ev.y), String(ev.x2), String(ev.y2), '250']);
    else if (ev.kind === 'text') await adb(['shell', 'input', 'text', adbText(ev.text ?? '')]);
    else if (ev.kind === 'key') await adb(['shell', 'input', 'keyevent', String(ANDROID_KEYS[(ev.key ?? '').toLowerCase()] ?? ev.key)]);
  }

  /** Agent commands: palco device <sub> "Device" ... */
  async command(id: string, sub: string, args: string[], callerId?: string): Promise<string> {
    const node = this.node(id);
    const d = node.data;
    if (d.platform === 'android') {
      const adb = this.adb(d);
      switch (sub) {
        case 'info': {
          const { stdout } = await adb(['shell', 'wm', 'size']);
          return `${nameOf(node)}: Android ${d.deviceId ?? '(padrão)'} — ${String(stdout).trim()}`;
        }
        case 'snapshot': {
          const { stdout } = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], 30_000);
          const nodes = parseUiautomator(String(stdout));
          this.uiCache.set(id, nodes);
          return nodes.map((n) => `- ${n.cls}${n.id ? `#${n.id}` : ''} "${n.text}"${n.clickable ? '' : ' [texto]'} @${n.ref}`).join('\n') || '(nenhum elemento visível)';
        }
        case 'click': case 'tap': {
          let x: number, y: number;
          if (args[0]?.startsWith('@')) {
            const el = this.uiCache.get(id)?.find((n) => n.ref === args[0].slice(1));
            if (!el) throw new PalcoError(`Referência ${args[0]} desconhecida. Rode \`palco device snapshot\` primeiro.`);
            ({ x, y } = el);
          } else {
            x = Number(args[0]); y = Number(args[1]);
            if (Number.isNaN(x) || Number.isNaN(y)) throw new PalcoError('Use @eN ou coordenadas X Y em pixels do aparelho.');
          }
          await adb(['shell', 'input', 'tap', String(x), String(y)]);
          return `Toque em ${x},${y}.`;
        }
        case 'type': await adb(['shell', 'input', 'text', adbText(args.join(' '))]); return 'Digitado.';
        case 'key': await this.input(id, { kind: 'key', key: args[0] }); return `Tecla ${args[0]}.`;
        case 'swipe': {
          const [x1, y1, x2, y2] = args.map(Number);
          await adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), '300']);
          return 'Deslizou.';
        }
        case 'launch': await adb(['shell', 'monkey', '-p', args[0] ?? '', '-c', 'android.intent.category.LAUNCHER', '1']); return `Abrindo ${args[0]}.`;
        case 'install': await adb(['install', '-r', path.resolve(args[0] ?? '')], 300_000); return 'Instalado.';
        case 'url': await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', args[0] ?? '']); return `Abrindo ${args[0]}.`;
        case 'screenshot': return this.saveShot(node);
        case 'logs': return String((await adb(['logcat', '-d', '-t', '200'])).stdout);
        default: throw new PalcoError(`Subcomando desconhecido para Android: ${sub}\n${DEVICE_HELP}`);
      }
    }
    const sim = await this.simId(d);
    switch (sub) {
      case 'info': return `${nameOf(node)}: Simulador iOS ${sim}`;
      case 'boot': await run('xcrun', ['simctl', 'boot', sim]).catch(() => undefined); await run('open', ['-a', 'Simulator']); return 'Simulador ligado.';
      case 'url': await run('xcrun', ['simctl', 'openurl', sim, args[0] ?? '']); return `Abrindo ${args[0]}.`;
      case 'launch': await run('xcrun', ['simctl', 'launch', sim, args[0] ?? '']); return `Abrindo ${args[0]}.`;
      case 'install': await run('xcrun', ['simctl', 'install', sim, path.resolve(args[0] ?? '')], 300_000); return 'Instalado.';
      case 'screenshot': return this.saveShot(node);
      case 'logs': return String((await run('xcrun', ['simctl', 'spawn', sim, 'log', 'show', '--last', '2m', '--style', 'compact'], 60_000)).stdout).slice(-20_000);
      // Interaction goes through the Simulator app's accessibility tree, with the user's consent.
      case 'snapshot': return this.core.computer!.run({ pos: ['snapshot', 'Simulator'], flags: {} }, callerId);
      case 'click': case 'tap': return this.core.computer!.run({ pos: ['click', 'Simulator', args[0] ?? ''], flags: {} }, callerId);
      case 'type': await this.core.computer!.run({ pos: ['focus', 'Simulator'], flags: {} }, callerId); return this.core.computer!.run({ pos: ['type', args.join(' ')], flags: {} }, callerId);
      case 'key': await this.core.computer!.run({ pos: ['focus', 'Simulator'], flags: {} }, callerId); return this.core.computer!.run({ pos: ['key', args[0] ?? ''], flags: {} }, callerId);
      default: throw new PalcoError(`Subcomando desconhecido para iOS: ${sub}\n${DEVICE_HELP}`);
    }
  }

  private async saveShot(node: PalcoNode<DeviceData>) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const f = path.join(SHOTS_DIR, `${nameOf(node).replace(/[^\w-]+/g, '_')}-${Date.now()}.png`);
    fs.writeFileSync(f, await this.screenshot(node.id));
    return f;
  }

  stopAll() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id, true);
  }
}

export const DEVICE_HELP = `palco device — aparelhos no canvas
  palco device status                         adb/simctl e aparelhos disponíveis
  palco device create "Nome" android|ios [--id SERIAL|UDID]
  palco device <sub> "Aparelho" ...
    Android: info snapshot click @eN|X Y type key(home|back|enter…) swipe X1 Y1 X2 Y2 launch PACOTE url URL install APK screenshot logs
    iOS:     info boot url launch BUNDLE install APP screenshot logs snapshot click @eN type key (estes 4 via computer use)`;
