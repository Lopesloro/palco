import { useEffect, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string) {
  return DOMPurify.sanitize(marked.parse(src ?? '', { async: false }) as string, { ADD_ATTR: ['target'] });
}

export function Markdown({ src, className }: { src: string; className?: string }) {
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />;
}

// ---------------------------------------------------------------- dialogs
export interface Field {
  key: string;
  label: string;
  value?: string;
  type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number';
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
}

interface DialogReq {
  title: string;
  fields: Field[];
  submit?: string;
  danger?: boolean;
  resolve: (v: Record<string, string> | undefined) => void;
}

let push: ((d: DialogReq) => void) | undefined;

export function dialog(title: string, fields: Field[], opts: { submit?: string; danger?: boolean } = {}) {
  return new Promise<Record<string, string> | undefined>((resolve) => push?.({ title, fields, ...opts, resolve }));
}

export function DialogHost() {
  const [req, setReq] = useState<DialogReq & { body?: string }>();
  const [vals, setVals] = useState<Record<string, string>>({});
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  useEffect(() => {
    push = (d) => {
      setReq(d);
      setVals(Object.fromEntries(d.fields.map((f) => [f.key, f.value ?? ''])));
    };
    return () => { push = undefined; };
  }, []);
  useEffect(() => { if (req) setTimeout(() => first.current?.focus(), 30); }, [req]);
  if (!req) return null;
  const close = (v?: Record<string, string>) => { req.resolve(v); setReq(undefined); };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="modal" onSubmit={(e) => { e.preventDefault(); close(vals); }} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>{req.title}</h3>
        {req.fields.map((f, i) => (
          <label key={f.key} className={`field ${f.type === 'checkbox' ? 'check' : ''}`}>
            <span>{f.label}</span>
            {f.type === 'textarea' ? (
              <textarea ref={i === 0 ? (first as never) : undefined} rows={8} value={vals[f.key]} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            ) : f.type === 'select' ? (
              <select ref={i === 0 ? (first as never) : undefined} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'checkbox' ? (
              <input type="checkbox" checked={vals[f.key] === 'true'} onChange={(e) => setVals({ ...vals, [f.key]: String(e.target.checked) })} />
            ) : (
              <input ref={i === 0 ? (first as never) : undefined} type={f.type === 'number' ? 'number' : 'text'} value={vals[f.key]} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            )}
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => close()}>Cancelar</button>
          <button type="submit" className={req.danger ? 'danger' : 'primary'}>{req.submit ?? 'OK'}</button>
        </div>
      </form>
    </div>
  );
}

export function Icon({ children, title, onClick, active, className }: { children: ReactNode; title: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; className?: string }) {
  return (
    <button type="button" className={`icon-btn ${active ? 'active' : ''} ${className ?? ''}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

export const STATUS_LABEL: Record<string, string> = { starting: 'iniciando', busy: 'trabalhando', idle: 'esperando', exited: 'encerrado' };

export function StatusDot({ status }: { status?: string }) {
  return <span className={`dot st-${status ?? 'exited'}`} title={STATUS_LABEL[status ?? 'exited']} />;
}

export function useDebounced<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  const t = useRef<number>(undefined);
  const f = useRef(fn);
  f.current = fn;
  return (...a: T) => {
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => f.current(...a), ms);
  };
}
