/**
 * The thin DSH adapter: DSH session content blocks <-> the ported core's
 * `Message` vocabulary, plus the renderer that turns kept messages back into
 * the text of one checkpoint.
 *
 * This file is the ONLY place that knows both vocabularies. Everything it calls
 * under `lib/vendor/` is upstream algorithm, unmodified.
 *
 * DSH shapes (verified against @deepseek-ai/dsh-llm):
 *   message   { role: 'system'|'user'|'assistant', content: ContentBlock[], ... }
 *   block     { type: 'text', text } | { type: 'reasoning', ... }
 *             { type: 'tool-call', id, name, arguments: string }
 *             { type: 'tool-result', toolCallId, content: ContentBlock[], isError? }
 *             { type: 'image' | 'file', ... }
 *
 * Upstream shapes: { role: 'user'|'assistant', text, toolUses[], toolResults? }.
 *
 * Two deliberate asymmetries, both to keep the numbers honest:
 *   - a tool result's text lives ONLY in `toolResults`, never duplicated into
 *     `toolUses[].text`, because upstream's `messageChars` counts both and the
 *     reduction ratio would then be measured against a doubled original;
 *   - `reasoning` blocks are dropped entirely (neither counted nor kept): they
 *     are not part of the transcript a resumed model needs back.
 */

import { truncate } from './vendor/state.js';

/** Cap on the serialised tool input carried into the checkpoint text. */
export const RENDER_INPUT_CHARS = 1000;

const IMAGE_PLACEHOLDER = '[image]';
const FILE_PLACEHOLDER = '[file]';

/** Text blocks only, ignoring tool-result content (that is priced separately). */
export function plainText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
        break;
      case 'image':
        parts.push(IMAGE_PLACEHOLDER);
        break;
      case 'file':
        parts.push(FILE_PLACEHOLDER);
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Recursive text of a tool result's content blocks. */
export function resultText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'tool-result':
        parts.push(resultText(block.content));
        break;
      case 'image':
        parts.push(IMAGE_PLACEHOLDER);
        break;
      case 'file':
        parts.push(FILE_PLACEHOLDER);
        break;
      default:
        break;
    }
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

/**
 * A result that holds an image or a file cannot be reproduced by re-running the
 * tool (the bytes may be gone), so its call is never a deletion candidate.
 * Upstream tracks this as its own open issue; here it is a hard pin.
 */
function isNonReproducible(blocks) {
  for (const block of blocks ?? []) {
    if (block?.type === 'image' || block?.type === 'file') return true;
    if (block?.type === 'tool-result' && isNonReproducible(block.content)) return true;
  }
  return false;
}

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { _unparsed: truncate(raw, 2000) };
  }
}

export function stringifyInput(input) {
  try {
    return truncate(JSON.stringify(input ?? {}), RENDER_INPUT_CHARS);
  } catch {
    return '{"_unserializable":true}';
  }
}

/**
 * Convert the DSH messages of the span being compacted into the ported core's
 * vocabulary.
 *
 * The leading `system` message is returned separately and kept OUT of the
 * message list: `buildSummarizationInput` prepends the system prompt only so
 * the region stays a genuine prefix of the last routed request, and upstream
 * pins index 0 — leaving the system prompt in place would pin it instead of the
 * span's real first message. The returned `systemText` is therefore never part
 * of the checkpoint either: that prompt is still on the surface.
 *
 * @returns {{messages: object[], systemText: string, protectedCallIds: Set<string>, risks: string[]}}
 */
export function fromDsh(messages) {
  const converted = [];
  const protectedCallIds = new Set();
  const risks = [];
  const resultIds = new Set();
  const callIds = new Set();
  let systemText = '';

  for (const message of messages ?? []) {
    const role = message?.role;
    const blocks = message?.content ?? [];
    if (role === 'system') {
      const text = plainText(blocks);
      if (text.length > 0) systemText = systemText.length === 0 ? text : `${systemText}\n${text}`;
      continue;
    }
    if (role !== 'user' && role !== 'assistant') {
      risks.push(`unsupported message role: ${String(role)}`);
      continue;
    }
    const toolUses = [];
    const toolResults = [];
    for (const block of blocks) {
      if (block?.type === 'tool-call') {
        const id = String(block.id ?? '');
        if (callIds.has(id)) risks.push(`duplicate tool call id: ${id}`);
        callIds.add(id);
        toolUses.push({
          tool_use_id: id,
          tool: String(block.name ?? 'tool'),
          input: parseArguments(block.arguments),
        });
      } else if (block?.type === 'tool-result') {
        const id = String(block.toolCallId ?? '');
        if (resultIds.has(id)) {
          risks.push(`duplicate tool result for call: ${id}`);
          continue;
        }
        resultIds.add(id);
        const result = { tool_use_id: id, text: resultText(block.content) };
        if (block.isError === true) result.isError = true;
        toolResults.push(result);
        if (isNonReproducible(block.content)) protectedCallIds.add(id);
      }
    }
    const entry = { role, text: plainText(blocks), toolUses };
    if (toolResults.length > 0) entry.toolResults = toolResults;
    converted.push(entry);
  }

  return { messages: converted, systemText, protectedCallIds, risks };
}

/**
 * Structural pairing problems that make a Jev-driven deletion unsafe. Any hit
 * means the caller must fall back to DSH's own compaction instead of trusting
 * the decisions: a result without its call, or a result that appears before the
 * call it answers, is a surface this adapter does not understand.
 */
export function pairingRisks(messages) {
  const risks = [];
  const callOrder = new Map();
  messages.forEach((message, index) => {
    for (const use of message.toolUses ?? []) {
      if (!callOrder.has(use.tool_use_id)) callOrder.set(use.tool_use_id, index);
    }
  });
  const seenResults = new Set();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      const callIndex = callOrder.get(result.tool_use_id);
      if (callIndex === undefined) risks.push(`orphan tool result (no call in this span): ${result.tool_use_id}`);
      else if (callIndex > index) risks.push(`tool result precedes its call: ${result.tool_use_id}`);
      if (seenResults.has(result.tool_use_id)) risks.push(`tool result answered twice: ${result.tool_use_id}`);
      seenResults.add(result.tool_use_id);
    }
  });
  return risks;
}

/**
 * Render the kept messages as the checkpoint text. Everything here is either
 * verbatim input text or a tool line; nothing is paraphrased, and a dropped
 * result is marked rather than silently missing so a resumed model knows the
 * output exists but was removed.
 */
export function renderCompacted(messages) {
  const lines = [];
  messages.forEach((message, index) => {
    const text = (message.text ?? '').trim();
    const results = new Map((message.toolResults ?? []).map((result) => [result.tool_use_id, result]));
    const rendered = new Set();
    if (text.length === 0 && (message.toolUses ?? []).length === 0 && results.size === 0) return;
    lines.push(`[${index + 1}] ${message.role}`);
    if (text.length > 0) lines.push(text);
    for (const use of message.toolUses ?? []) {
      lines.push(`[call] ${use.tool} ${stringifyInput(use.input)}`);
      const result = results.get(use.tool_use_id);
      if (result === undefined) continue;
      rendered.add(use.tool_use_id);
      lines.push(`[result]${result.isError === true ? ' error' : ''}`);
      if (result.text.length > 0) lines.push(result.text);
    }
    for (const result of message.toolResults ?? []) {
      if (rendered.has(result.tool_use_id)) continue;
      lines.push(`[result]${result.isError === true ? ' error' : ''}`);
      if (result.text.length > 0) lines.push(result.text);
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

/** Characters of a rendered checkpoint. */
export function viewChars(text) {
  return text.length;
}
