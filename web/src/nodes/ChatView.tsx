import { useEffect, useRef, useState } from 'react';
import { fileUrl, op, upload } from '../api';
import { setState, toast, useStore } from '../store';
import { Markdown } from '../ui';
import type { ChatEntry } from '../types';

const EMPTY: ChatEntry[] = [];

export function ChatView({ id, name }: { id: string; name: string }) {
  const entries = useStore((s) => s.chats[id] ?? EMPTY);
  const [text, setText] = useState(() => localStorage.getItem(`palco.chatdraft.${id}`) ?? '');
  const [files, setFiles] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    op<ChatEntry[]>('chat.read', { nodeId: id })
      .then((log) => setState((s) => ({ chats: { ...s.chats, [id]: log } })))
      .catch(() => {});
  }, [id]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [entries.length]);
  useEffect(() => { localStorage.setItem(`palco.chatdraft.${id}`, text); }, [id, text]);

  const submit = async () => {
    if (!text.trim() && !files.length) return;
    try {
      await op('chat.send', { nodeId: id, text, attachments: files });
      setText('');
      setFiles([]);
    } catch (e) {
      toast((e as Error).message, 'Chat');
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    try {
      const paths = await Promise.all(imgs.map((f) => upload(f, f.type.split('/')[1] || 'png')));
      setFiles((x) => [...x, ...paths]);
    } catch (err) {
      toast((err as Error).message, 'Anexo');
    }
  };

  return (
    <div className="chat nodrag nowheel">
      <div className="chat-list" ref={list}>
        {entries.length === 0 && <div className="empty">Converse com {name} aqui. O agente responde com <code>palco say</code>.</div>}
        {entries.map((e) => (
          <div key={e.id} className={`bubble from-${e.from}`}>
            <div className="who">{e.from === 'user' ? 'Você' : e.name ?? (e.from === 'agent' ? name : e.from)} · {new Date(e.ts).toLocaleTimeString()}</div>
            <Markdown src={e.text} />
            {e.attachments?.map((a) => (/\.(png|jpe?g|gif|webp)$/i.test(a)
              ? <img key={a} className="attach-img" src={fileUrl(a)} alt={a} draggable />
              : <a key={a} className="attach" href={fileUrl(a)} target="_blank" rel="noreferrer">📎 {a.split('/').pop()}</a>))}
          </div>
        ))}
      </div>
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span className="chip" key={i}>🖼 {f.split('/').pop()} <b onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</b></span>)}</div>}
      <div className="chat-input">
        <textarea
          value={text}
          placeholder={`Mensagem para ${name} (Enter envia, Shift+Enter quebra linha)`}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        <button className="primary" onClick={() => void submit()}>Enviar</button>
      </div>
    </div>
  );
}
