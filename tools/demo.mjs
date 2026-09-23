/**
 * The offline end-to-end run: one realistic span through the whole pipeline,
 * with a scripted Jev so the numbers are reproducible.
 *
 * It answers the three questions of the first validation round without a live
 * session — does the token count drop, does the text that matters survive
 * verbatim, is a removed thing marked — and prints the same numbers the log
 * records. It is a harness for judging the DECISION RULE, not a substitute for
 * watching a real session in shadow mode.
 *
 *   node tools/demo.mjs            # 12 tool calls, scripted probabilities
 *   node tools/demo.mjs --keep 0.5 # re-score the same span at another threshold
 */

import { fromDsh, pairingRisks, renderCompacted } from '../lib/adapter.js';
import { applyDecisions, compact, messageChars, reductionRatio } from '../lib/vendor/compact.js';
import { collectToolCalls, estimateTokens } from '../lib/vendor/state.js';

const thresholdArg = process.argv.indexOf('--keep');
const keepThreshold = thresholdArg === -1 ? 0.4 : Number(process.argv[thresholdArg + 1]);

function text(value) {
  return { type: 'text', text: value };
}

/** One long tool output, of the shape that actually fills a context window. */
function bulk(label, lines) {
  return Array.from({ length: lines }, (_, index) => `${label} line ${index + 1}: ${'detail '.repeat(8)}`).join('\n');
}

/**
 * A span with the mix a real session has: a user constraint near the top, old
 * exploration whose output nobody needs any more, the current error, and the
 * newest exchange that must not be touched.
 */
function span() {
  const messages = [
    { role: 'system', content: [text('You are a coding agent working in C:\\repo.')] },
    { role: 'user', content: [text('Add pagination to the orders list. Keep the existing API contract; do not rename the cursor field.')] },
  ];
  const old = [
    ['read_file', { file_path: 'src/orders/router.ts' }, 'export function list() { /* ... */ }'],
    ['search', { q: 'cursor' }, bulk('search-hit', 120)],
    ['read_file', { file_path: 'docs/api.md' }, bulk('api-doc', 90)],
    ['run_tests', { suite: 'orders' }, bulk('test-log', 60)],
    ['read_file', { file_path: 'node_modules/orm/lib/query.js' }, bulk('vendor', 200)],
  ];
  old.forEach(([name, args, output], index) => {
    messages.push({ role: 'assistant', content: [toolCall(`o${index}`, name, args)] });
    messages.push({ role: 'user', content: [toolResult(`o${index}`, output)] });
  });
  messages.push({ role: 'assistant', content: [text('The router builds the cursor in two places; changing it would break the contract, so I will add a second parameter instead.')] });
  const recent = [
    ['read_file', { file_path: 'src/orders/router.ts' }, 'export function list(page?: number) { /* patched */ }'],
    ['run_tests', { suite: 'orders' }, 'FAIL: 1 of 24 tests — orders > paginates past the last page'],
    ['read_file', { file_path: 'src/orders/paginate.ts' }, 'export function clamp(offset: number, total: number) { /* ... */ }'],
  ];
  recent.forEach(([name, args, output], index) => {
    messages.push({ role: 'assistant', content: [toolCall(`r${index}`, name, args)] });
    messages.push({ role: 'user', content: [toolResult(`r${index}`, output, { isError: index === 1 })] });
  });
  messages.push({ role: 'assistant', content: [text('The failure is a boundary bug in clamp; fixing it now.')] });
  return messages;
}

function toolCall(id, name, args) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
}

function toolResult(id, value, options = {}) {
  const block = { type: 'tool-result', toolCallId: id, content: [text(value)] };
  if (options.isError === true) block.isError = true;
  return block;
}

/**
 * Scripted Jev: old exploration is stale (low), the assistant's own constraint
 * reasoning and the current failure are not. The newest calls are pinned.
 */
function scriptedAsker() {
  let ask = 0;
  const table = new Map([
    ['t1', { call: 0.35, result: 0.12 }],
    ['t2', { call: 0.3, result: 0.08 }],
    ['t3', { call: 0.25, result: 0.1 }],
    ['t4', { call: 0.4, result: 0.15 }],
    ['t5', { call: 0.2, result: 0.05 }],
  ]);
  return {
    get calls() {
      return ask;
    },
    async ask(_state, questions) {
      ask += 1;
      const answers = {};
      for (const name of Object.keys(questions)) {
        const id = name.replace(/^(call|result)_/, '');
        const entry = table.get(id) ?? { call: 0.9, result: 0.85 };
        answers[name] = { type: 'noul', noul: name.startsWith('call_') ? entry.call : entry.result };
      }
      return { answers, model: 'jev-scripted' };
    },
  };
}

const preserve = 6;
const truncateHeadChars = 300;
const converted = fromDsh(span());
const risks = [...converted.risks, ...pairingRisks(converted.messages)];
if (risks.length > 0) {
  console.log('PAIRING RISKS — the plugin would fall back to DSH here:', risks);
}

const calls = collectToolCalls(converted.messages, preserve);
const asker = scriptedAsker();
const result = await compact(converted.messages, asker, {
  preserveRecentMessages: preserve,
  keepThreshold,
  truncateHeadChars,
});
const protectedKeep = result.decisions.map((decision) => {
  if (decision.action === 'keep') return decision;
  const call = calls.find((candidate) => candidate.id === decision.id);
  if (call === undefined || !converted.protectedCallIds.has(call.tool_use_id)) return decision;
  return { ...decision, action: 'keep', reason: 'protected' };
});
const kept = applyDecisions(converted.messages, protectedKeep, calls, truncateHeadChars);
const view = renderCompacted(kept);

const charsBefore = converted.messages.reduce((sum, message) => sum + messageChars(message), 0);
const charsAfter = kept.reduce((sum, message) => sum + messageChars(message), 0);
const tokensBefore = estimateTokens(renderCompacted(converted.messages));
const tokensAfter = estimateTokens(view);

console.log(`span: ${converted.messages.length} messages, ${calls.length} paired tool calls (threshold ${keepThreshold})`);
console.log(
  `decisions: keep ${protectedKeep.filter((d) => d.reason === 'kept').length}, ` +
    `drop_result ${protectedKeep.filter((d) => d.reason === 'result_dropped').length}, ` +
    `drop_call ${protectedKeep.filter((d) => d.reason === 'call_dropped').length}, ` +
    `pinned ${protectedKeep.filter((d) => d.reason === 'pinned').length}`,
);
console.log(`state: ~${result.stats.stateTokens} tokens at stage "${result.stats.stateStage}" in ${result.stats.requests} request(s)`);
console.log(`chars: ${charsBefore} -> ${charsAfter}  (ratio ${(reductionRatio(result) * 100).toFixed(1)}%)`);
console.log(`tokens (estimate): ${tokensBefore} -> ${tokensAfter}  (${tokensBefore - tokensAfter} saved)`);

const mustKeep = [
  'do not rename the cursor field',
  'The router builds the cursor in two places',
  'FAIL: 1 of 24 tests',
  'boundary bug in clamp',
];
console.log('');
for (const needle of mustKeep) {
  console.log(`${view.includes(needle) ? 'kept    ' : 'MISSING '} ${needle}`);
}
console.log(`${view.includes('context-curator dropped') ? 'marked  ' : 'MISSING '} a dropped result says what was removed`);
console.log(`${!view.includes('vendor line 200') ? 'dropped ' : 'STILL THERE '} the vendor bundle dump`);
