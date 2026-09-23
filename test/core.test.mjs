/**
 * Core behaviour of the port, checked without a DSH process: the adapter, the
 * three-state decision, the rebuild, the safety fallbacks and the renderer.
 *
 * These are the first three questions of the validation round in unit form —
 * "does the token count drop", "does the kept text survive verbatim", "is a
 * dropped thing marked". The end-to-end behaviour (a real session, a real
 * compact, a real agent continuing) is checked by `tools/demo.mjs` and by
 * watching the running plugin, not here.
 *
 * The span below is deliberately shaped like a real one: ten messages, four
 * tool calls, the span's first message carrying the user's constraint. With
 * `preserveRecentMessages: 4` exactly t1 and t2 are candidates and t3/t4 are
 * inside the preserved tail, which makes the pinning rule assertable.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fromDsh, pairingRisks, renderCompacted } from '../lib/adapter.js';
import { applyDecisions, compact, reductionRatio } from '../lib/vendor/compact.js';
import { collectToolCalls, estimateTokens } from '../lib/vendor/state.js';

const PRESERVE = 4;

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

const BULK = 'x'.repeat(4000);

/** A span shaped like the one DSH hands to `summarize()`. */
function span() {
  return [
    { role: 'system', content: [text('you are a coding agent')] },
    { role: 'user', content: [text('Fix the failing build. Do not touch the schema.')] },
    { role: 'assistant', content: [text('Reading the config.'), toolCall('c1', 'read_file', { file_path: 'a.json' })] },
    { role: 'user', content: [toolResult('c1', BULK)] },
    { role: 'assistant', content: [toolCall('c2', 'search', { q: 'schema' })] },
    { role: 'user', content: [toolResult('c2', '{"hits":2}')] },
    { role: 'assistant', content: [toolCall('c3', 'run_tests', {})] },
    { role: 'user', content: [toolResult('c3', 'FAIL: 3 of 12 tests', { isError: true })] },
    { role: 'assistant', content: [text('The schema field is the cause.'), toolCall('c4', 'read_file', { file_path: 'b.json' })] },
    { role: 'user', content: [toolResult('c4', '{"name":"b"}')] },
    { role: 'assistant', content: [text('Working on it.')] },
  ];
}

test('adapter separates the system prompt and pairs calls with results', () => {
  const converted = fromDsh(span());
  assert.equal(converted.messages.length, 10, 'the system message stays out of the span');
  assert.equal(converted.systemText, 'you are a coding agent');
  assert.equal(converted.messages[0].role, 'user');
  assert.deepEqual(pairingRisks(converted.messages), []);

  const calls = collectToolCalls(converted.messages, PRESERVE);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.tool), ['read_file', 'search', 'run_tests', 'read_file']);
  assert.deepEqual(calls.map((call) => call.pinned), [false, false, true, true]);
  // the 4000-char output is counted once, not once per side of the pair
  const message0 = converted.messages.findIndex((message) => message.toolResults !== undefined);
  assert.equal(converted.messages[message0].toolResults[0].text.length, 4000);
  assert.equal(converted.messages[message0].toolUses.length, 0);
});

test('a malformed pairing is reported instead of guessed at', () => {
  const orphan = [
    { role: 'user', content: [text('hi')] },
    { role: 'user', content: [toolResult('missing', 'no call for this')] },
  ];
  const risks = pairingRisks(fromDsh(orphan).messages);
  assert.equal(risks.length, 1);
  assert.match(risks[0], /orphan tool result/);
});

test('a duplicate result for one call is a reported risk', () => {
  const duplicated = [
    { role: 'user', content: [text('hi')] },
    { role: 'assistant', content: [toolCall('c1', 'read_file', {})] },
    { role: 'user', content: [toolResult('c1', 'first')] },
    { role: 'user', content: [toolResult('c1', 'second')] },
  ];
  // the adapter drops the second answer and reports it, so the caller falls back
  const converted = fromDsh(duplicated);
  assert.ok(converted.risks.some((risk) => /duplicate tool result/.test(risk)));
  assert.equal(converted.messages.filter((message) => message.toolResults !== undefined).length, 1);

  // and the structural check catches the same shape in messages built by hand
  const upstream = [
    { role: 'user', text: 'hi', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'read_file', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'first' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'second' }] },
  ];
  assert.ok(pairingRisks(upstream).some((risk) => /answered twice/.test(risk)));
});

test('a result holding an image is protected from deletion', () => {
  const withImage = [
    { role: 'user', content: [text('look')] },
    { role: 'assistant', content: [toolCall('c1', 'screenshot', {})] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', data: 'AA' }] }] },
  ];
  const converted = fromDsh(withImage);
  assert.equal(converted.protectedCallIds.size, 1);
  assert.ok(converted.protectedCallIds.has('c1'));
});

/** Records the raw probabilities the asker was handed, as the log does. */
function fixedAsker(table) {
  const seen = [];
  return {
    seen,
    async ask(_state, questions) {
      const answers = {};
      for (const name of Object.keys(questions)) {
        const id = name.replace(/^(call|result)_/, '');
        const entry = table[id] ?? { call: 1, result: 1 };
        const value = name.startsWith('call_') ? entry.call : entry.result;
        seen.push({ name, value });
        answers[name] = { type: 'noul', noul: value };
      }
      return { answers, model: 'jev-test' };
    },
  };
}

test('the three-state decision follows the two probabilities', async () => {
  const converted = fromDsh(span());
  const asker = fixedAsker({
    t1: { call: 0.9, result: 0.1 }, // the call matters, its 4000-char output does not
    t2: { call: 0.1, result: 0.05 }, // stale search: the whole call can go
    t3: { call: 0.1, result: 0.1 }, // pinned, so Jev is never even asked
  });
  const result = await compact(converted.messages, asker, { preserveRecentMessages: PRESERVE, keepThreshold: 0.4 });

  const byId = new Map(result.decisions.map((decision) => [decision.id, decision]));
  assert.equal(byId.get('t1').action, 'drop_result');
  assert.equal(byId.get('t2').action, 'drop_call');
  assert.equal(byId.get('t3').action, 'keep');
  assert.equal(byId.get('t3').reason, 'pinned');
  assert.ok(reductionRatio(result) > 0.5, 'dropping one 4k result is most of the payload');

  const askedNames = asker.seen.map((entry) => entry.name);
  assert.ok(!askedNames.includes('call_t3'), 'a pinned call costs no Jev question');
  assert.ok(askedNames.includes('result_t1'));
  // the raw probabilities survive into the decision, which is what lets the
  // threshold be re-picked later without re-running anything
  assert.equal(byId.get('t1').keepResult, 0.1);
  assert.equal(byId.get('t1').keepCall, 0.9);
});

test('a dropped call disappears with its result, and a dropped result keeps a head', async () => {
  const converted = fromDsh(span());
  const calls = collectToolCalls(converted.messages, PRESERVE);
  const asker = fixedAsker({
    t1: { call: 0.9, result: 0.1 },
    t2: { call: 0.1, result: 0.1 },
  });
  const result = await compact(converted.messages, asker, {
    preserveRecentMessages: PRESERVE,
    keepThreshold: 0.4,
    truncateHeadChars: 50,
  });
  const kept = applyDecisions(converted.messages, result.decisions, calls, 50);
  const rendered = renderCompacted(kept);

  assert.ok(!rendered.includes('search'), 'a dropped call takes its tool line with it');
  assert.ok(!rendered.includes('{"hits":2}'), 'and its result');
  assert.ok(rendered.includes('context-curator dropped'), 'the truncated result says what was removed');
  assert.ok(rendered.includes('x'.repeat(50)), 'the kept head is the real head');
  assert.ok(!rendered.includes(BULK), 'the body is gone');
  assert.ok(rendered.includes('Fix the failing build. Do not touch the schema.'), 'user text stays verbatim');
  assert.ok(rendered.includes('The schema field is the cause.'), 'assistant text stays verbatim');
  assert.ok(rendered.includes('FAIL: 3 of 12 tests'), 'a pinned result stays verbatim');
});

test('the newest messages and the first message are never touched', async () => {
  const converted = fromDsh(span());
  const asker = fixedAsker({ t1: { call: 0, result: 0 }, t2: { call: 0, result: 0 } });
  const result = await compact(converted.messages, asker, { preserveRecentMessages: PRESERVE });
  const decided = result.decisions.filter((decision) => decision.reason === 'pinned');
  assert.equal(decided.length, 2, 't3 and t4 sit inside the preserved tail');
  for (const decision of decided) assert.equal(decision.action, 'keep');
});

test('a state that cannot be fitted throws, so the caller can fall back', async () => {
  const converted = fromDsh(span());
  const asker = fixedAsker({});
  await assert.rejects(
    () => compact(converted.messages, asker, { maxStateTokens: 60, preserveRecentMessages: 0 }),
    /history too large for Jev/,
  );
});

test('a malformed Jev answer throws rather than defaulting to deletion', async () => {
  const converted = fromDsh(span());
  const broken = {
    async ask() {
      return { answers: { call_t1: { type: 'noul' } } };
    },
  };
  await assert.rejects(() => compact(converted.messages, broken, { preserveRecentMessages: PRESERVE }), /Invalid Jev answer/);
});

test('the token estimate is monotone in text length', () => {
  const short = estimateTokens('hello world');
  const long = estimateTokens('hello world '.repeat(50));
  assert.ok(long > short * 40);
});

/**
 * Regression — the status tool must reach the engine through its closure, not
 * through `this`. `execute` is a plain property of the tool object and DSH calls
 * it as `tool.execute(args)`, so a method shorthand leaves `this` bound to the
 * tool object: `buildReport` gets `config === undefined` and the tool answers
 * "Status: UNAVAILABLE" instead of a report. The arrow form keeps the engine
 * `this` that the enclosing `ctx.inject(['tools'], (scope) => …)` captured.
 */
test('the status tool reaches the engine without relying on this', async (t) => {
  let Context = null;
  let ContextCuratorEngine = null;
  let mkdtempSync = null;
  let tmpdir = null;
  let join = null;
  try {
    ({ mkdtempSync } = await import('node:fs'));
    ({ tmpdir } = await import('node:os'));
    ({ join } = await import('node:path'));
    ({ Context } = await import('@deepseek-ai/cordis'));
    ({ ContextCuratorEngine } = await import('../lib/index.js'));
  } catch (error) {
    t.skip(`cordis is not resolvable from here: ${String(error?.message ?? error)}`);
    return;
  }

  const logPath = join(mkdtempSync(join(tmpdir(), 'curator-status-')), 'status.jsonl');
  const root = new Context();
  const registered = [];
  root.provide('tools');
  root.tools = { register: (tool) => registered.push(tool) };

  const engine = new ContextCuratorEngine(root, { adopt: false, logPath });
  assert.equal(engine.curator.enabled, true);

  // cordis resolves an injected service on a later tick, so give the
  // registration a moment to land before asserting on it.
  for (let waited = 0; waited < 100 && registered.length === 0; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const tool = registered.find((candidate) => candidate.name === 'jev_compaction_status');
  assert.ok(tool !== undefined, 'the tool registers once a tools service exists');

  // called the way DSH calls it: as a detached property of the tool object
  const report = await tool.execute({ limit: 5 });
  assert.equal(typeof report, 'string');
  assert.ok(
    !report.includes('UNAVAILABLE'),
    'a this-binding failure must not be reported as a status report',
  );
  assert.match(report, /verdict:/);
  assert.match(report, /keep threshold/);
});
