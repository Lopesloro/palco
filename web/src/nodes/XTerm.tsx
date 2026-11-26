import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { onMessage, send } from '../api';
import { getState } from '../store';

const THEME = {
  background: '#0f1115', foreground: '#d7dae0', cursor: '#e8a33d', selectionBackground: '#3a4150',
  black: '#1b1e24', red: '#e06464', green: '#5fb37a', yellow: '#e8a33d', blue: '#4f9dde', magenta: '#c66bd1', cyan: '#3fb8b0', white: '#d7dae0',
  brightBlack: '#5c6370', brightRed: '#ff7b7b', brightGreen: '#7fd398', brightYellow: '#ffc062', brightBlue: '#73b6f0', brightMagenta: '#dd8be6', brightCyan: '#5fd6ce', brightWhite: '#ffffff',
};

export function XTerm({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "JetBrains Mono", monospace',
      fontSize: getState().config?.settings.terminalFontSize ?? 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    let ready = false;
    const pending: string[] = [];
    const off = onMessage((m) => {
      if (m.id !== id) return;
      if (m.t === 'replay') {
        term.reset();
        term.write(m.data);
        ready = true;
        for (const p of pending.splice(0)) term.write(p);
      } else if (m.t === 'out') {
        if (ready) term.write(m.data); else pending.push(m.data);
      } else if (m.t === 'open') {
        send({ t: 'attach', id });
      }
    });
    const offOpen = onMessage((m) => { if (m.t === 'open') send({ t: 'attach', id }); });
    const sub = term.onData((d) => send({ t: 'input', id, data: d }));
    let last = '';
    const doFit = () => {
      if (!host.current || host.current.offsetWidth < 20) return;
      try { fit.fit(); } catch { return; }
      const key = `${term.cols}x${term.rows}`;
      if (key !== last) {
        last = key;
        send({ t: 'resize', id, cols: term.cols, rows: term.rows });
      }
    };
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(doFit); });
    ro.observe(host.current!);
    doFit();
    send({ t: 'attach', id });
    return () => {
      off();
      offOpen();
      sub.dispose();
      ro.disconnect();
      cancelAnimationFrame(raf);
      term.dispose();
    };
  }, [id]);
  return <div className="xterm-host nodrag nowheel nopan" ref={host} onMouseDown={(e) => e.stopPropagation()} />;
}
