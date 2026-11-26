import { describe, expect, it } from 'vitest';
import { parseArgs, parseDuration } from '../server/commands.js';
import { decodeRaw, shellQuote } from '../server/sessions.js';
import { parseEvery } from '../server/routines.js';
import { normalizeUrl } from '../server/portals.js';
import { guessAgentType } from '../server/core.js';

describe('parseArgs', () => {
  it('splits positionals and flags, honouring boolean flags', () => {
    expect(parseArgs(['ask', 'Beta', '--raw', 'x\\n'])).toEqual({ pos: ['ask', 'Beta', 'x\\n'], flags: { raw: true } });
    expect(parseArgs(['recruit', 'A', '--preset', 'Codex', '--role=Rev'])).toEqual({ pos: ['recruit', 'A'], flags: { preset: 'Codex', role: 'Rev' } });
    expect(parseArgs(['floor', 'delete', 'X', '--force'])).toEqual({ pos: ['floor', 'delete', 'X'], flags: { force: true } });
    expect(parseArgs(['a', '--', '--not-a-flag'])).toEqual({ pos: ['a', '--not-a-flag'], flags: {} });
    expect(parseArgs(['note', 'create', 'x', '--stack', 'Sprint'])).toEqual({ pos: ['note', 'create', 'x'], flags: { stack: 'Sprint' } });
  });
});

describe('helpers', () => {
  it('decodes raw escapes', () => {
    expect(decodeRaw('2\\n')).toBe('2\r');
    expect(decodeRaw('\\x03')).toBe('\x03');
    expect(decodeRaw('\\e[A')).toBe('\x1b[A');
  });
  it('quotes for the shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
  it('parses durations and intervals', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseEvery('2h')).toBe(7200);
    expect(() => parseEvery('5s')).toThrow(/mínimo/);
    expect(() => parseEvery('abc')).toThrow();
  });
  it('normalizes portal urls', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://x.y')).toBe('http://x.y');
  });
  it('guesses agent type from command', () => {
    expect(guessAgentType('claude --model opus')).toBe('claude_code');
    expect(guessAgentType('FOO=1 /opt/bin/codex --yolo')).toBe('codex');
    expect(guessAgentType('')).toBe('shell');
    expect(guessAgentType('htop')).toBe('custom');
  });
});

import { attentionReason, extractReply } from '../server/sessions.js';

const CLAUDE_TRUST = ` Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

const CODEX_UPDATE = `  ✨  Update available! 0.147.0 -> 0.172.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs \`brew upgrade --cask codex\`)
  2. Skip
  3. Skip until next version
  Press enter to continue`;

const CLAUDE_IDLE = `⏺ No Palco você aparece como Claude. Você pode aprovar o plano depois, se quiser.
✻ Sautéed for 24s · done 3:27 PM
────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "fix typecheck errors"
────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5.5 | med | Downloads | (main) | Quality --
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents`;

const CLAUDE_PERMISSION = ` Bash command
   rm -rf build
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No, and tell Claude what to do differently (esc)`;

describe('attention detection', () => {
  it('flags prompts that only the human may answer', () => {
    expect(attentionReason(CLAUDE_TRUST)).toMatch(/confia/);
    expect(attentionReason(CODEX_UPDATE)).toBeTruthy();
    expect(attentionReason(CLAUDE_PERMISSION)).toBeTruthy();
    expect(attentionReason('Overwrite file? (y/n)')).toBeTruthy();
  });
  it('does not flag an idle agent whose reply mentions approvals or updates', () => {
    expect(attentionReason(CLAUDE_IDLE)).toBeUndefined();
    expect(attentionReason('user@mac ~ % echo update available\nupdate available\nuser@mac ~ %')).toBeUndefined();
  });
});

describe('reply extraction', () => {
  it('keeps the answer and drops the echoed prompt and the input box', () => {
    const screen = `❯ Rode palco list e me diga com quem
  você está conectado.
  Ran 1 shell command
${CLAUDE_IDLE}`;
    const r = extractReply(screen, 'Rode palco list e me diga com quem\nvocê está conectado.');
    expect(r).toContain('No Palco você aparece como Claude');
    expect(r).not.toContain('Opus 5.5');
    expect(r).not.toContain('Try "fix typecheck errors"');
    expect(r).not.toContain('Rode palco list');
  });
  it('keeps only the last real message after tool calls', () => {
    const screen = `❯ Peça ao Codex quanto é 3 + 4
  Did not run 1 call
  ⎿  $ palco ask "Codex" "3+4"
⏺ 1. Pedido: perguntar ao Codex.
  Ran 4 shell commands
⏺ Bash(palco note edit "Placar")
⏺ feito. O Codex respondeu 7.

✻ Crunched for 2m 37s · done 4:02 PM
${'─'.repeat(40)}
❯
${'─'.repeat(40)}
  Opus 5.5 | med`;
    expect(extractReply(screen, 'Peça ao Codex quanto é 3 + 4')).toBe('feito. O Codex respondeu 7.');
  });
  it('does not mistake a sentence with a parenthesis for a tool call', () => {
    expect(extractReply('❯ atualize\n⏺ Bash(npm test)\n⏺ README(s) atualizados e testes verdes.', 'atualize')).toBe('README(s) atualizados e testes verdes.');
  });
  it('strips the Codex input line and model footer', () => {
    const r = extractReply('› Responda só com o número\n\n• 42\n\n \n› Find and fix a bug in @filename\n \n  gemma default · ~/x', 'Responda só com o número');
    expect(r).toBe('42');
  });
  it('returns shell output after the command', () => {
    const r = extractReply('user ~ % ls\nold\nuser ~ % echo palco-42\npalco-42\nuser ~ %', 'echo palco-42');
    expect(r).toBe('palco-42\nuser ~ %');
  });
});
