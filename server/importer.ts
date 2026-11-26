import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Core } from './core.js';
import { guessAgentType } from './core.js';
import type { NoteData, TerminalData } from './types.js';

/**
 * Imports workspaces from a local Maestri install (~/.maestri) for interoperability:
 * terminals (name, command, folder, position), notes and agent ropes. Read-only on the source.
 */
export function importMaestri(core: Core, root = path.join(os.homedir(), '.maestri')) {
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { imported: 0, message: 'Nenhuma instalação do Maestri encontrada em ~/.maestri.' };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { workspaces?: { id: string; name: string; path: string }[] };
  let imported = 0;
  const report: string[] = [];
  for (const entry of manifest.workspaces ?? []) {
    const file = path.join(root, entry.path);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const src = raw.payload ?? raw;
    const dir = typeof src.workingDirectory === 'string' && fs.existsSync(src.workingDirectory) ? src.workingDirectory : os.homedir();
    const ws = core.store.createWorkspace(`${src.name ?? entry.name} (Maestri)`, dir);
    const ground = core.groundOf(ws);
    const idMap = new Map<string, string>();
    let terms = 0, notes = 0;
    for (const n of src.nodes ?? []) {
      const frame = Array.isArray(n.frame) ? n.frame : [[0, 0], [700, 450]];
      const [[x, y], [w, h]] = frame as [[number, number], [number, number]];
      const content = n.content ?? {};
      const t = content.terminal?._0 ?? content.terminal;
      if (t && typeof t === 'object') {
        const command = String(t.command ?? '');
        const node = core.addNode<TerminalData>(ws, 'terminal', {
          name: String(t.name ?? 'Terminal'), command,
          cwd: typeof t.workingDirectory === 'string' && fs.existsSync(t.workingDirectory) ? t.workingDirectory : dir,
          agentType: guessAgentType(command), color: typeof t.color === 'string' ? t.color : '#4f9dde', chat: false,
        }, { floorId: ground.id, x, y, w: Math.max(w, 400), h: Math.max(h, 260) });
        idMap.set(String(t.id ?? n.id), node.id);
        idMap.set(String(n.id), node.id);
        terms++;
        continue;
      }
      const note = content.note?._0 ?? content.note ?? content.stickyNote?._0 ?? content.stickyNote;
      if (note && typeof note === 'object') {
        const body = typeof note.text === 'string' ? note.text : typeof note.content === 'string' ? note.content : readNoteFile(root, entry.id, note.id ?? n.id);
        const node = core.addNode<NoteData>(ws, 'note', {
          name: String(note.name ?? note.title ?? 'Nota'), color: 'yellow', locked: !!n.isLocked, preview: true,
        }, { floorId: ground.id, x, y, w: Math.max(w, 220), h: Math.max(h, 180) });
        core.store.writeNote(ws.id, node.id, body);
        idMap.set(String(note.id ?? n.id), node.id);
        idMap.set(String(n.id), node.id);
        notes++;
      }
    }
    for (const c of [...(src.connections ?? []), ...(src.noteConnections ?? []), ...(src.noteToNoteConnections ?? [])]) {
      const a = idMap.get(String(c.terminalIdA ?? c.terminalId ?? c.noteIdA ?? c.fromId ?? ''));
      const b = idMap.get(String(c.terminalIdB ?? c.noteId ?? c.noteIdB ?? c.toId ?? ''));
      if (a && b) {
        try { core.connect(ws, a, b, { quiet: true }); } catch { /* incompatible pair */ }
      }
    }
    imported++;
    report.push(`"${ws.name}": ${terms} terminais, ${notes} notas`);
  }
  return { imported, message: imported ? `Importados: ${report.join('; ')}` : 'Nada para importar.' };
}

function readNoteFile(root: string, wsId: string, noteId: string) {
  const dir = path.join(root, 'workspaces', wsId, 'notes');
  for (const f of [`${noteId}.md`, `${noteId}.txt`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return '';
}
