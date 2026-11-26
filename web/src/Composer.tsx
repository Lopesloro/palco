import { useEffect, useMemo, useRef, useState } from 'react';
import { op, upload } from './api';
import { toast, useStore } from './store';
import type { PalcoNode, Workspace } from './types';

const nm = (n: PalcoNode) => (n.data as { name: string }).name;
const token = (name: string) => (/\s/.test(name) ? `@"${name}"` : `@${name}`);

/** Floating prompt box: talk to one or many terminals, @-mention agents, notes and portals. */
export function Composer({ ws }: { ws: Workspace }) {
  const selection = useStore((s) => s.selection);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<{ q: string; start: number; idx: number }>();
  const ta = useRef<HTMLTextAreaElement>(null);

  const named = useMemo(() => ws.nodes.filter((n) => n.type !== 'drawing' && n.type !== 'band'), [ws.nodes]);
  const mentioned = useMemo(() => named.filter((n) => text.includes(token(nm(n)))), [named, text]);
  const targets = useMemo(() => {
    const m = mentioned.filter((n) => n.type === 'terminal');
    return m.length ? m : named.filter((n) => n.type === 'terminal' && selection.includes(n.id));
  }, [mentioned, named, selection]);
  const draftKey = `palco.draft.${targets.map((t) => t.id).sort().join(',') || ws.id}`;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ta.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { if (!text) setText(localStorage.getItem(draftKey) ?? ''); }, [draftKey]);
  useEffect(() => { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); }, [text, draftKey]);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return named.filter((n) => nm(n).toLowerCase().includes(q)).slice(0, 8);
  }, [mention, named]);

  const onChange = (v: string, caret: number) => {
    setText(v);
    const before = v.slice(0, caret);
    const m = before.match(/@"?([^@"\n]*)$/);
    setMention(m ? { q: m[1], start: caret - m[0].length, idx: 0 } : undefined);
  };
  const pick = (n: PalcoNode) => {
    if (!mention || !ta.current) return;
    const caret = ta.current.selectionStart;
    const next = `${text.slice(0, mention.start)}${token(nm(n))} ${text.slice(caret)}`;
    setText(next);
    setMention(undefined);
    requestAnimationFrame(() => ta.current?.focus());
  };

  const submit = async () => {
    if (!text.trim()) return;
    if (!targets.length) return toast('Escolha quem recebe: selecione terminais no canvas ou @mencione um agente.', 'Compositor');
    // mentioning a note or portal wires it to the receivers so they can actually use it
    const extras = mentioned.filter((n) => n.type !== 'terminal');
    try {
      for (const t of targets) for (const x of extras) await op('edge.add', { wsId: ws.id, a: t.id, b: x.id }).catch(() => {});
      const hints = extras.map((x) => x.type === 'note' ? `(nota "${nm(x)}": leia com palco note read "${nm(x)}")` : `(portal "${nm(x)}": use palco portal snapshot "${nm(x)}")`);
      await op('compose.send', { targets: targets.map((t) => t.id), text: [text, ...hints].join('\n'), attachments: files });
      toast(`Enviado para ${targets.map(nm).join(', ')}`, 'Compositor');
      localStorage.removeItem(draftKey);
      setText('');
      setFiles([]);
    } catch (e) {
      toast((e as Error).message, 'Compositor');
    }
  };

  return (
    <div className="composer-dock">
      <div className="composer-to">
        <span className="muted small">Para</span>
        {targets.length
          ? targets.map((t) => <b key={t.id} className="chip">{nm(t)}</b>)
          : <span className="muted small">selecione cartões no canvas ou escreva @Nome</span>}
      </div>
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={f} className="chip">🖼 {f.split('/').pop()} <b onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</b></span>)}</div>}
      <textarea
        ref={ta}
        value={text}
        rows={1}
        placeholder="Mensagem para os agentes… (@ menciona agentes, notas e portais · Enter envia · Shift+Enter quebra linha · ⌘K foca)"
        onInput={(e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onPaste={async (e) => {
          const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
          if (!imgs.length) return;
          e.preventDefault();
          const paths = await Promise.all(imgs.map((f) => upload(f, f.type.split('/')[1] || 'png')));
          setFiles((x) => [...x, ...paths]);
        }}
        onKeyDown={(e) => {
          if (mention && options.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setMention({ ...mention, idx: (mention.idx + 1) % options.length }); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMention({ ...mention, idx: (mention.idx - 1 + options.length) % options.length }); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[mention.idx]); return; }
          }
          if (e.key === 'Escape') { setMention(undefined); return; }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
        }}
      />
      <button className="primary send" disabled={!text.trim()} onClick={() => void submit()}>Enviar</button>
      {mention && options.length > 0 && (
        <ul className="mentions">
          {options.map((n, i) => (
            <li key={n.id} className={i === mention.idx ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>
              {n.type === 'terminal' ? '✦' : n.type === 'note' ? '📝' : '🌐'} {nm(n)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
