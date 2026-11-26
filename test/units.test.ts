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
