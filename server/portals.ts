import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { Core, PalcoError, nameOf } from './core.js';
import { PALCO_HOME, SHOTS_DIR } from './paths.js';
import type { PortalData, PalcoNode } from './types.js';

const UA = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
};

export function findChrome(): string | undefined {
  const candidates = [
    process.env.PALCO_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const pw = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      candidates.push(path.join(pw, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      candidates.push(path.join(pw, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  }
  return candidates.find((c) => c && fs.existsSync(c));
}

interface Live {
  ctx: BrowserContext;
  page: Page;
  cdp?: CDPSession;
  viewers: number;
  logs: string[];
  casting: boolean;
}

/** Snapshot script runs in the page: tags interactive elements with refs the agent can target. */
const SNAPSHOT_JS = `(() => {
  let n = 0;
  document.querySelectorAll('[data-palco-ref]').forEach(e => e.removeAttribute('data-palco-ref'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch],[role=radio],[role=combobox],[role=textbox],[contenteditable=true],h1,h2,h3,h4,img[alt],label';
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const roleOf = (e) => e.getAttribute('role') || ({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button',IMG:'img',LABEL:'label',H1:'heading',H2:'heading',H3:'heading',H4:'heading'})[e.tagName] || (e.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'})[e.type] || 'textbox' : e.tagName.toLowerCase());
  const nameOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('placeholder') || e.getAttribute('title') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.innerText || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const out = [];
  for (const e of document.querySelectorAll(sel)) {
    if (!visible(e)) continue;
    const ref = 'e' + (++n);
    e.setAttribute('data-palco-ref', ref);
    const role = roleOf(e);
    let line = role + ' "' + nameOf(e).replace(/"/g, "'") + '"';
    if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') line += ' value="' + String(e.value || '').slice(0, 60) + '"';
    if (e.type === 'checkbox' || e.type === 'radio') line += e.checked ? ' [checked]' : ' [unchecked]';
    if (e.disabled) line += ' [disabled]';
    if (e.tagName === 'A') line += ' -> ' + e.getAttribute('href');
    out.push('- ' + line + ' @' + ref);
    if (n >= 400) { out.push('- … (truncado em 400 elementos)'); break; }
  }
  return out.join('\\n');
})()`;

export class Portals extends EventEmitter {
  private browser?: Promise<Browser>;
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<Live>>();

  constructor(private core: Core) {
    super();
    core.portalHook = { close: (id) => void this.close(id) };
    const t = setInterval(() => void this.saveAll(), 60_000);
    t.unref();
  }

  private statePath(id: string) {
    return path.join(PALCO_HOME, 'portals', `${id}.json`);
  }

  private async getBrowser() {
    if (!this.browser) {
      this.browser = (async () => {
        const { chromium } = await import('playwright-core');
        const executablePath = findChrome();
        if (!executablePath) throw new PalcoError('Nenhum Chrome/Chromium encontrado. Instale o Google Chrome ou defina PALCO_CHROME.');
        const b = await chromium.launch({ executablePath, headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-first-run'] });
        b.on('disconnected', () => { this.browser = undefined; this.live.clear(); });
        return b;
      })();
      this.browser.catch(() => { this.browser = undefined; });
    }
    return this.browser;
  }

  private async open(node: PalcoNode<PortalData>): Promise<Live> {
    const cur = this.live.get(node.id);
    if (cur) return cur;
    const pending = this.opening.get(node.id);
    if (pending) return pending;
    const p = (async () => {
      const browser = await this.getBrowser();
      const sp = this.statePath(node.id);
      const d = node.data;
      const ctx = await browser.newContext({
        viewport: d.viewport,
        storageState: fs.existsSync(sp) ? sp : undefined,
        userAgent: d.ua && d.ua !== 'desktop' ? UA[d.ua] : undefined,
        isMobile: d.ua === 'ios' || d.ua === 'android',
        hasTouch: d.ua === 'ios' || d.ua === 'android',
      });
      const page = await ctx.newPage();
      const live: Live = { ctx, page, viewers: 0, logs: [], casting: false };
      page.on('console', (m) => {
        live.logs.push(`[${m.type()}] ${m.text()}`);
        if (live.logs.length > 500) live.logs.shift();
      });
      page.on('pageerror', (e) => live.logs.push(`[pageerror] ${e.message}`));
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) this.onNavigated(node.id, page.url());
      });
      this.live.set(node.id, live);
      if (d.url) await page.goto(normalizeUrl(d.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => live.logs.push(`[goto] ${e.message}`));
      return live;
    })();
    this.opening.set(node.id, p);
    try {
      return await p;
    } finally {
      this.opening.delete(node.id);
    }
  }

  private onNavigated(id: string, url: string) {
    const hit = this.core.store.findWorkspaceOfNode(id);
    if (!hit) return;
    const d = hit.node.data as PortalData;
    if (d.url !== url && url !== 'about:blank') {
      d.url = url;
      this.core.store.touch(hit.ws);
    }
  }

  async close(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    await live.ctx.close().catch(() => {});
  }

  async saveAll() {
    for (const [id, l] of this.live) {
      fs.mkdirSync(path.dirname(this.statePath(id)), { recursive: true });
      await l.ctx.storageState({ path: this.statePath(id) }).catch(() => {});
    }
  }

  async shutdown() {
    await this.saveAll();
    const b = await this.browser?.catch(() => undefined);
    await b?.close().catch(() => {});
  }

  private nodeOf(id: string) {
    const hit = this.core.locate(id);
    if (hit.node.type !== 'portal') throw new PalcoError(`${nameOf(hit.node)} não é um portal.`);
    return hit.node as PalcoNode<PortalData>;
  }

  // ---- live view for the UI ---------------------------------------------
  async watch(id: string) {
    const live = await this.open(this.nodeOf(id));
    live.viewers++;
    if (!live.casting) {
      live.casting = true;
      live.cdp = await live.ctx.newCDPSession(live.page);
      live.cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
        this.emit('frame', id, f.data);
        (live.cdp?.send as (m: string, p: unknown) => Promise<unknown>)?.call(live.cdp, 'Page.screencastAck', { sessionId: f.sessionId }).catch(() => {});
      });
      const vp = live.page.viewportSize() ?? { width: 1280, height: 800 };
      await live.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
    }
    // push one frame right away so a fresh viewer is never blank
    const shot = await live.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => undefined);
    if (shot) this.emit('frame', id, shot.toString('base64'));
  }

  async unwatch(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    live.viewers = Math.max(0, live.viewers - 1);
    if (live.viewers === 0 && live.cdp) {
      await live.cdp.send('Page.stopScreencast').catch(() => {});
      await live.cdp.detach().catch(() => {});
      live.cdp = undefined;
      live.casting = false;
    }
  }

  async input(id: string, ev: { kind: string; x?: number; y?: number; button?: 'left' | 'right' | 'middle'; dx?: number; dy?: number; key?: string; text?: string; url?: string; mods?: string[] }) {
    const live = await this.open(this.nodeOf(id));
    const { page } = live;
    switch (ev.kind) {
      case 'move': return page.mouse.move(ev.x!, ev.y!);
      case 'down': await page.mouse.move(ev.x!, ev.y!); return page.mouse.down({ button: ev.button });
      case 'up': await page.mouse.move(ev.x!, ev.y!); return page.mouse.up({ button: ev.button });
      case 'wheel': await page.mouse.move(ev.x!, ev.y!); return page.mouse.wheel(ev.dx ?? 0, ev.dy ?? 0);
      case 'key': {
        const combo = [...(ev.mods ?? []), ev.key!].join('+');
        if (!ev.mods?.length && ev.key!.length === 1) return page.keyboard.type(ev.key!);
        return page.keyboard.press(combo);
      }
      case 'text': return page.keyboard.insertText(ev.text ?? '');
      case 'navigate': return page.goto(normalizeUrl(ev.url!), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      case 'back': return page.goBack().catch(() => {});
      case 'forward': return page.goForward().catch(() => {});
      case 'reload': return page.reload().catch(() => {});
    }
  }

  async setViewport(id: string, width: number, height: number) {
    const node = this.nodeOf(id);
    node.data.viewport = { width: Math.round(width), height: Math.round(height) };
    const live = this.live.get(id);
    if (live) {
      await live.page.setViewportSize(node.data.viewport);
      if (live.cdp) {
        await live.cdp.send('Page.stopScreencast').catch(() => {});
        await live.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 }).catch(() => {});
      }
    }
  }

  // ---- agent commands ----------------------------------------------------
  async command(id: string, sub: string, args: string[]): Promise<string> {
    const node = this.nodeOf(id);
    const live = await this.open(node);
    const { page } = live;
    const ref = (r?: string) => {
      if (!r || !/^@?e\d+$/.test(r)) throw new PalcoError(`Referência inválida "${r ?? ''}". Rode \`palco portal snapshot\` e use @eN.`);
      return page.locator(`[data-palco-ref="${r.replace('@', '')}"]`).first();
    };
    const settle = () => page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    switch (sub) {
      case 'info':
        return `url: ${page.url()}\ntítulo: ${await page.title()}\nviewport: ${node.data.viewport.width}x${node.data.viewport.height}\nua: ${node.data.ua ?? 'desktop'}`;
      case 'navigate': {
        if (!args[0]) throw new PalcoError('Uso: palco portal navigate "Portal" "url"');
        await page.goto(normalizeUrl(args[0]), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        return `Abriu ${page.url()} — ${await page.title()}`;
      }
      case 'back': await page.goBack(); return page.url();
      case 'forward': await page.goForward(); return page.url();
      case 'reload': await page.reload(); return page.url();
      case 'snapshot': {
        const tree = (await page.evaluate(SNAPSHOT_JS)) as string;
        return `# ${await page.title()}\n# ${page.url()}\n${tree || '(nenhum elemento interativo visível)'}`;
      }
      case 'click': await ref(args[0]).click({ timeout: 10_000 }); await settle(); return `Clicou ${args[0]}. Agora em ${page.url()}`;
      case 'hover': await ref(args[0]).hover({ timeout: 10_000 }); return `Hover em ${args[0]}`;
      case 'focus': await ref(args[0]).focus({ timeout: 10_000 }); return `Foco em ${args[0]}`;
      case 'check': await ref(args[0]).setChecked(!(await ref(args[0]).isChecked()), { timeout: 10_000 }); return `Alternou ${args[0]}`;
      case 'fill': await ref(args[0]).fill(args[1] ?? '', { timeout: 10_000 }); return `Preencheu ${args[0]}`;
      case 'type': await ref(args[0]).pressSequentially(args[1] ?? '', { delay: 15, timeout: 20_000 }); return `Digitou em ${args[0]}`;
      case 'select': await ref(args[0]).selectOption({ label: args[1] }, { timeout: 10_000 }); return `Selecionou "${args[1]}" em ${args[0]}`;
      case 'upload': {
        const f = path.resolve(args[1] ?? '');
        if (!fs.existsSync(f)) throw new PalcoError(`Arquivo não existe: ${f}`);
        await ref(args[0]).setInputFiles(f);
        return `Enviou ${f}`;
      }
      case 'key': {
        const combo = (args[0] ?? '').split('+').map((k) => ({ ctrl: 'Control', cmd: 'Meta', meta: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift', enter: 'Enter', esc: 'Escape', tab: 'Tab' } as Record<string, string>)[k.toLowerCase()] ?? k).join('+');
        await page.keyboard.press(combo);
        return `Tecla ${combo}`;
      }
      case 'selectall': await page.keyboard.press('ControlOrMeta+a'); return 'Selecionou tudo';
      case 'scroll': {
        const dir = args[0] ?? 'down';
        const amount = Number(args[1] ?? 400);
        const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
        const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
        if (args[2]?.startsWith('@')) await ref(args[2]).hover();
        else if (args[2]?.includes(',')) { const [x, y] = args[2].split(',').map(Number); await page.mouse.move(x, y); }
        await page.mouse.wheel(dx, dy);
        return `Rolou ${dir} ${amount}px`;
      }
      case 'scrollintoview': await ref(args[0]).scrollIntoViewIfNeeded(); return `Visível: ${args[0]}`;
      case 'text': return args[0] ? (await ref(args[0]).innerText()).trim() : (await page.locator('body').innerText()).slice(0, 20_000);
      case 'html': return (await page.content()).slice(0, 200_000);
      case 'evaluate': return JSON.stringify(await page.evaluate(args[0] ?? 'undefined'), null, 2) ?? 'undefined';
      case 'screenshot': {
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        const f = path.join(SHOTS_DIR, `${nameOf(node).replace(/[^\w-]+/g, '_')}-${Date.now()}.png`);
        await page.screenshot({ path: f, fullPage: args.includes('--full') });
        return f;
      }
      case 'resize': {
        const w = Number(args[0]), h = Number(args[1]);
        if (!w || !h) throw new PalcoError('Uso: palco portal resize "Portal" 390 844');
        await this.setViewport(id, w, h);
        this.core.store.touch(this.core.locate(id).ws);
        return `Viewport ${w}x${h}`;
      }
      case 'ua': {
        const kind = (args[0] ?? 'desktop') as PortalData['ua'];
        if (!['desktop', 'ios', 'android'].includes(kind!)) throw new PalcoError('Use: ios, android ou desktop');
        node.data.ua = kind;
        if (kind !== 'desktop' && node.data.viewport.width > 600) node.data.viewport = kind === 'ios' ? { width: 390, height: 844 } : { width: 412, height: 915 };
        if (kind === 'desktop' && node.data.viewport.width < 600) node.data.viewport = { width: 1280, height: 800 };
        await this.saveAll();
        await this.close(id);
        this.core.store.touch(this.core.locate(id).ws);
        await this.open(node);
        return `User agent ${kind}, viewport ${node.data.viewport.width}x${node.data.viewport.height}`;
      }
      case 'logs': return live.logs.join('\n') || '(sem logs)';
      case 'logs-start': live.logs = []; return 'Logs limpos; capturando a partir de agora.';
      case 'clear': live.logs = []; return 'Logs limpos.';
      default:
        throw new PalcoError(`Subcomando de portal desconhecido: ${sub}. Veja: palco portal --help`);
    }
  }
}

export function normalizeUrl(u: string) {
  const s = u.trim();
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:') || s.startsWith('data:')) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(s)) return `http://${s}`;
  return `https://${s}`;
}
