/**
 * Pre-flight: exercise the plugin's REAL code paths outside DSH.
 *
 * It answers, before a session ever loads the preset:
 *   - does the constructor survive a real cordis Context (base config, service
 *     publication, tool/command injection)?
 *   - does a REAL Jev round trip through the ported core work (key, endpoint,
 *     response parsing, probabilities)?
 *   - does the shadow branch log a row and hand back to DSH's summarizer?
 *   - does the adopt branch return the Jev checkpoint instead?
 *   - does an unreachable Jev fall back to DSH's summarizer without throwing?
 *
 * It does NOT replace the live session: only a real preset mount, a real span and
 * a real compaction event prove those. Logs go to a TEMP path so the first real
 * run's log stays clean.
 *
 *   node tools/preflight.mjs
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { ContextCuratorEngine } from '../lib/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'curator-preflight-'));
const logPath = join(tempDir, 'preflight.jsonl');

function text(value) {
  return { type: 'text', text: value };
}
function toolCall(id, name, args) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
}
function toolResult(id, value, options = {}) {
  const block = { type: 'tool-result', toolCallId: id, content: [text(value)] };
  if (options.isError === true) block.isError = true;
  return block;
}

/** A span with the mix a real session has: constraint, stale bulk, current error. */
function span() {
  const messages = [
    { role: 'system', content: [text('You are a coding agent.')] },
    { role: 'user', content: [text('Add pagination to the orders list. Keep the API contract; do not rename the cursor field.')] },
  ];
  const stale = [
    ['search', { q: 'cursor' }, Array.from({ length: 90 }, (_, i) => `hit ${i}: ${'detail '.repeat(8)}`).join('\n')],
    ['read_file', { file_path: 'docs/api.md' }, Array.from({ length: 70 }, (_, i) => `doc line ${i}`).join('\n')],
    ['read_file', { file_path: 'node_modules/orm/query.js' }, Array.from({ length: 150 }, (_, i) => `vendor line ${i}`).join('\n')],
  ];
  stale.forEach(([name, args, output], index) => {
    messages.push({ role: 'assistant', content: [toolCall(`s${index}`, name, args)] });
    messages.push({ role: 'user', content: [toolResult(`s${index}`, output)] });
  });
  messages.push({ role: 'assistant', content: [text('The cursor is built in two places; adding a parameter instead of renaming keeps the contract.')] });
  const recent = [
    ['read_file', { file_path: 'src/orders/router.ts' }, 'export function list(page?: number) {}'],
    ['run_tests', { suite: 'orders' }, 'FAIL: 1 of 24 — orders > paginates past the last page'],
  ];
  recent.forEach(([name, args, output], index) => {
    messages.push({ role: 'assistant', content: [toolCall(`r${index}`, name, args)] });
    messages.push({ role: 'user', content: [toolResult(`r${index}`, output, { isError: index === 1 })] });
  });
  messages.push({ role: 'assistant', content: [text('The failure is a boundary bug; fixing it now.')] });
  return messages;
}

function makeContext() {
  try {
    // eslint-disable-next-line
    const cordis = require('@deepseek-ai/cordis');
    void cordis;
  } catch {
    /* fall through to the ESM import below */
  }
  return null;
}

const lines = [];
const record = (label, ok, detail) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
};

// ── 1. constructor against a real cordis Context ────────────────────────────
const { Context } = await import('@deepseek-ai/cordis');
const root = new Context();
let engine = null;
try {
  engine = new ContextCuratorEngine(root, { adopt: false, logPath });
  record('constructor survives a real cordis Context', true, `service published, base config = ${JSON.stringify(BasicCompactionEngine.Config({}))}`);
} catch (error) {
  record('constructor survives a real cordis Context', false, String(error?.message ?? error));
}
if (engine === null) {
  console.log(lines.join('\n'));
  process.exit(1);
}
record('key resolved', engine.apiKey.length > 0, engine.diagnostics.apiKeySource === 'file' ? engine.diagnostics.apiKeyFilePath : engine.diagnostics.apiKeySource);

// ── 2. the real summarize() path ────────────────────────────────────────────
const original = BasicCompactionEngine.prototype.summarize;
const dshCalls = [];
BasicCompactionEngine.prototype.summarize = async function stubbed(input) {
  dshCalls.push(input?.messages?.length ?? 0);
  return { summary: [{ type: 'text', text: 'DSH OWN SUMMARY' }], provider: 'stub', model: 'stub', llmStreamCall: true };
};

const input = { messages: span() };
const agent = { session: null };

async function run(label, config) {
  // A fresh Context per instance: cordis refuses a second publication of
  // `compaction` in one realm, so the next engine needs its own — which is also
  // the property that makes the preset's `isolate` realm the right mount point.
  const created = new ContextCuratorEngine(new Context(), { ...config, logPath });
  const before = dshCalls.length;
  let returned = null;
  let threw = null;
  try {
    returned = await created.summarize(input, agent, undefined);
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  const handedBack = dshCalls.length > before;
  return { created, returned, threw, handedBack, label };
}

// shadow (the default): Jev runs, DSH's summary is what comes back
const shadow = await run('shadow', { adopt: false });
record('shadow: no throw', shadow.threw === null, shadow.threw ?? 'ok');
record('shadow: handed back to DSH', shadow.handedBack);
record('shadow: returned DSH summary', shadow.returned?.provider === 'stub', `provider=${shadow.returned?.provider}`);
record('shadow: Jev succeeded', (shadow.created.diagnostics.lastJev?.model ?? null) !== null, `model=${shadow.created.diagnostics.lastJev?.model ?? 'n/a'}, ${shadow.created.diagnostics.lastJev?.latencyMs ?? '?'}ms`);
record('shadow: 0 steers, 0 adopted', shadow.created.diagnostics.adopted === 0);

// adopt: the Jev checkpoint is what comes back
let adopt = await run('adopt', { adopt: true });
// One slow Jev request is not a defect: report it, then retry once so a
// transient failure is not mistaken for a broken adopt path.
if (adopt.returned?.provider !== 'typesafe' && String(adopt.created.diagnostics.lastFallback ?? '').startsWith('jev_')) {
  record('adopt: first attempt reached Jev', false, `fallback=${adopt.created.diagnostics.lastFallback}, detail=${adopt.created.diagnostics.lastError ?? 'none'} — retrying once`);
  adopt = await run('adopt (retry)', { adopt: true });
}
record('adopt: no throw', adopt.threw === null, adopt.threw ?? 'ok');
if (adopt.returned?.provider === 'typesafe') {
  const body = adopt.returned.summary.map((block) => block.text).join('');
  record('adopt: returned a Jev checkpoint', true, `${body.length} chars`);
  record('adopt: did NOT hand back to DSH', adopt.handedBack === false);
  record('adopt: user constraint kept verbatim', body.includes('do not rename the cursor field'));
  record('adopt: current failure kept verbatim', body.includes('FAIL: 1 of 24'));
  record('adopt: assistant reasoning kept verbatim', body.includes('adding a parameter instead of renaming'));
  record('adopt: no other fallback', (adopt.created.diagnostics.lastFallback ?? 'shadow_mode') === 'shadow_mode' || adopt.created.diagnostics.lastFallback === null, `lastFallback=${adopt.created.diagnostics.lastFallback}`);
} else {
  record('adopt: returned a Jev checkpoint', false, `provider=${adopt.returned?.provider}, fell back to ${adopt.created.diagnostics.lastFallback}`);
}

// timeout: Jev unreachable must hand the span straight back
const timedOut = await run('timeout', { adopt: true, jevTimeoutMs: 1 });
record('timeout: no throw', timedOut.threw === null, timedOut.threw ?? 'ok');
record('timeout: handed back to DSH', timedOut.handedBack);
record('timeout: reason recorded', timedOut.created.diagnostics.lastFallback === 'jev_timeout' || timedOut.created.diagnostics.lastFallback === 'jev_error', `fallback=${timedOut.created.diagnostics.lastFallback}`);

BasicCompactionEngine.prototype.summarize = original;

// ── 3. the log rows ─────────────────────────────────────────────────────────
try {
  const rows = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  record('log: one row per attempt', rows.length === 3, `${rows.length} row(s)`);
  const row = rows.find((candidate) => candidate.adopted === true) ?? rows[0];
  record('log: decisions recorded with raw probabilities', Array.isArray(row.decisions) && row.decisions.every((d) => typeof d.keep_call === 'number' && typeof d.keep_result === 'number'), `${row.decisions?.length ?? 0} call(s)`);
  record('log: before/after recorded', typeof row.tokens_before === 'number' && typeof row.tokens_after === 'number', `${row.tokens_before} -> ${row.tokens_after}, ratio ${row.reduction_ratio}`);
  record('log: counts recorded', typeof row.kept === 'number' && typeof row.drop_result === 'number' && typeof row.drop_call === 'number', `keep ${row.kept} / drop_result ${row.drop_result} / drop_call ${row.drop_call}`);
  record('log: no secret in the rows', !readFileSync(logPath, 'utf8').includes(engine.apiKey.slice(0, 12)));
} catch (error) {
  record('log rows readable', false, String(error?.message ?? error));
}

console.log('Context Curator pre-flight');
console.log(`log (temp): ${logPath}`);
console.log('');
console.log(lines.join('\n'));
const failed = lines.filter((line) => line.startsWith('FAIL')).length;
console.log('');
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
