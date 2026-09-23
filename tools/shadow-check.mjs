/**
 * The first-run checklist, as one command.
 *
 * It reads the curator's own JSONL and answers the questions the first real
 * end-to-end run has to answer, one line each, so nobody has to eyeball a log to
 * decide whether the plugin actually worked.
 *
 * Deliberately NOT a test suite and NOT a second report: `/curator` prints the
 * same rows for a human reading them, and this maps them onto the checklist and
 * says pass / no-data / not-exercised for each item.
 *
 *   node tools/shadow-check.mjs
 *   node tools/shadow-check.mjs --log <path>
 *
 * THE ONE THING IT SAYS OUT LOUD: with `adopt: false` the Jev checkpoint is
 * never sent to DSH — DSH's own summary is committed instead. So in shadow mode
 * "the context actually got smaller" and "the agent kept working on the trimmed
 * view" are NOT testable, and neither are the compaction-event fields, because
 * the event still carries DSH's own summary. Those three items are reported as
 * not-exercised rather than quietly passed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const logIndex = args.indexOf('--log');
const logPath =
  logIndex === -1
    ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'context-curator', 'curator.jsonl')
    : args[logIndex + 1];

const rows = [];
let corrupt = 0;
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      corrupt += 1;
    }
  }
}

const pids = new Set(rows.map((row) => row.pid));
const attempts = rows.length;
const last = attempts === 0 ? null : rows[attempts - 1];
const jevOk = rows.filter((row) => typeof row.requests === 'number' && row.requests > 0);
const latencies = jevOk
  .map((row) => row.jev_latency_ms)
  .filter((value) => typeof value === 'number')
  .sort((a, b) => a - b);
const pairingFailures = rows.filter((row) => row.fallback === 'pairing_risk').length;
const internalFailures = rows.filter((row) => row.fallback === 'internal_error').length;
const jevFailures = rows.filter((row) => ['jev_timeout', 'jev_error', 'no_key', 'malformed'].includes(row.fallback)).length;
const cacheRows = rows.filter((row) => row.usage !== undefined && row.usage !== null);
const shadowRows = rows.filter((row) => row.fallback === 'shadow_mode').length;
const adoptRows = rows.filter((row) => row.adopted === true).length;

function line(label, verdict, detail) {
  const padded = label.padEnd(34, '.');
  console.log(`${padded} ${verdict}${detail === undefined ? '' : `  — ${detail}`}`);
}

console.log('Context Curator — first real run checklist');
console.log(`log: ${logPath}`);
console.log(`rows: ${attempts}${corrupt > 0 ? ` (${corrupt} unreadable line(s) skipped)` : ''}${pids.size > 0 ? `, written by ${pids.size} process(es)` : ''}`);
console.log('');

if (attempts === 0) {
  line('1. plugin loaded', 'NO DATA', 'no rows: either the preset was not used, or nothing has compacted yet');
  console.log('');
  console.log('A row appears the first time DSH decides to compact. If the preset is');
  console.log('selected and a long session has run, this should not stay empty.');
  process.exit(0);
}

line('1. plugin loaded', 'PASS', `${attempts} attempt(s) recorded`);
line('2. summarize() called', 'PASS', `${attempts} time(s), last ${last.at}`);
line('3. Jev request succeeded', jevOk.length === 0 ? 'FAIL' : jevFailures === attempts ? 'FAIL' : 'PASS',
  `${jevOk.length}/${attempts} attempts asked; ${jevFailures} failed; median ${latencies.length === 0 ? 'n/a' : `${latencies[Math.floor(latencies.length / 2)]}ms`}`);
line('4. tokens before -> after', typeof last.tokens_before === 'number' ? 'PASS' : 'NO DATA',
  `${last.tokens_before ?? '?'} -> ${last.tokens_after ?? '?'}`);
line('5. reduction ratio', typeof last.reduction_ratio === 'number' ? 'PASS' : 'NO DATA',
  `${(Number(last.reduction_ratio ?? 0) * 100).toFixed(1)}% on the last attempt`);
line('6. KEEP / DROP_RESULT / DROP_CALL', 'INFO',
  `${last.kept ?? '?'} / ${last.drop_result ?? '?'} / ${last.drop_call ?? '?'}`);
line('7. recent messages pinned', (last.pinned ?? 0) > 0 ? 'PASS' : 'CHECK',
  `${last.pinned ?? 0} pinned of ${last.calls ?? 0} calls`);
line('8. pairing intact', pairingFailures === 0 ? 'PASS' : 'FAIL',
  pairingFailures === 0 ? 'no pairing_risk fallback; no orphan or duplicate pairs seen' : `${pairingFailures} attempt(s) hit a pairing risk`);
line('9. cache tokens recorded', cacheRows.length === 0 ? 'NO DATA' : 'PASS',
  cacheRows.length === 0
    ? 'the routed request has not reported usage yet'
    : `read ${last.usage.cache_read_tokens ?? '?'} / write ${last.usage.cache_write_tokens ?? '?'} on the last attempt`);
line('10. fallback path sane', internalFailures === 0 ? 'PASS' : 'FAIL',
  internalFailures === 0
    ? shadowRows === attempts ? 'every attempt fell back to DSH, as shadow mode intends' : `${attempts - shadowRows - jevFailures} attempt(s) had another fallback reason`
    : `${internalFailures} attempt(s) failed inside the plugin`);

console.log('');
console.log('not exercised in shadow mode (adopt: false) — check these after adopt: true');
line('11. compaction event fields', 'NOT EXERCISED', 'DSH committed its own summary, so provider/usage came from DSH');
line('12. context really smaller', 'NOT EXERCISED', 'the Jev checkpoint was never sent to the model');
line('13. agent kept working', 'NOT EXERCISED', 'the agent continued on DSH\'s summary, not on the trimmed view');
if (adoptRows > 0) {
  console.log('');
  console.log(`note: ${adoptRows} attempt(s) DID adopt — re-run /curator and judge items 11-13 on those rows`);
}
