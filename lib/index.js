/**
 * dsh-context-curator — keep the context lean without rewriting it.
 *
 * WHAT IT IS
 * ----------
 * A drop-in replacement for DSH's `compaction-basic` backend. It keeps that
 * backend's trigger policy, retention policy, durable log transaction and
 * surface replacement — all of it — and overrides the ONE hook the backend
 * documents as its customization point: `summarize(input, agent, signal)`.
 *
 * Where the stock backend asks a model to REWRITE the span into prose, this one
 * asks Jev (a fast typed classifier) two yes/no questions about every tool call
 * in the span — "does the call still matter", "does its output still need to be
 * verbatim" — and then deletes only what it is confident about. Kept text is
 * carried VERBATIM; the user's words and the assistant's ordinary text are never
 * paraphrased. That is the whole design: drop old tool noise, keep everything
 * else byte for byte.
 *
 *   DSH span messages -> adapter -> ported compaction core -> decisions
 *                     -> checkpoint text -> DSH surface replace
 *                     ...or, whenever anything is uncertain, DSH's own summary.
 *
 * ALWAYS FALLS BACK, NEVER HALF-WAY
 * ---------------------------------
 * No key, no candidates, a pairing that does not look like a clean call/result
 * pair, a state that will not fit, a Jev timeout, a malformed answer, too small
 * a saving, or a checkpoint that is not clearly smaller than what it replaces:
 * every one of those hands the span back to `super.summarize()`, which is
 * exactly what DSH would have done anyway. The agent never notices.
 *
 * SHADOW FIRST
 * ------------
 * `adopt: false` (the default) runs the entire pipeline and LOGS what it would
 * have done, but returns DSH's own summary. The first version is therefore
 * measurable before it is trusted: read the log, compare the decisions, then set
 * `adopt: true`.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No per-turn pruning, no per-tool-result Jev call, no background pass, no
 * second controller. It runs exactly when DSH was already going to compact, and
 * it never mutates the session log beyond the one replacement checkpoint the
 * backend was going to write anyway — the original events stay in the log, so a
 * replay still shows the truth and a bad decision is undone by editing config,
 * not by repairing history.
 *
 * The upstream core it ports is MIT; see THIRD_PARTY_NOTICES.md. The threshold
 * it ships with is deliberately NOT upstream's: see `keepThreshold` below.
 */

import z from 'schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

import { applyDecisions, compact, messageChars } from './vendor/compact.js';
import { collectToolCalls, estimateTokens } from './vendor/state.js';
import { fromDsh, pairingRisks, renderCompacted } from './adapter.js';
import { JevError, ask, resolveApiKey, redact } from './jev.js';
import { CuratorLog, LOG_VERSION } from './log.js';
import { MAX_HEALTH_LIMIT, buildReport, renderReport } from './health.js';

const PLUGIN = 'dsh-context-curator';

/** Bumped when the meaning of a log row or of a decision changes. */
export const CURATOR_VERSION = 1;
/** The upstream commit the core under `lib/vendor/` was ported from. */
export const CORE_VERSION = 'fast-jev-compaction@e3f262a';

/**
 * Upstream ships 0.5 and this does not, on purpose. Its own issue tracker has an
 * open question about that number and about the probability scale behind it, and
 * our Jev model may not be the one it was calibrated on. Until our log has rows,
 * the honest default is the conservative one: a low threshold means "keep unless
 * Jev is quite sure", and keeping is always safe — it only costs tokens.
 * Every row records the raw pair of probabilities, so the threshold can be moved
 * later against evidence instead of against a guess.
 */
export const KEEP_THRESHOLD_DEFAULT = 0.4;

export const Config = z.object({
  /** Master switch. Off = pure passthrough to DSH's own compaction. */
  enabled: z.boolean().default(true),
  /**
   * false = SHADOW: run everything, log the decisions, return DSH's summary.
   * true = the Jev checkpoint is used when it is clearly smaller and safe.
   */
  adopt: z.boolean().default(false),
  /** Minimum Jev probability for a call or its result to survive. */
  keepThreshold: z.number().default(KEEP_THRESHOLD_DEFAULT),
  /** Newest messages never touched (the span's first message is always kept). */
  preserveRecentMessages: z.natural().default(6),
  /** Estimated token ceiling for the Jev state. */
  maxStateTokens: z.natural().default(25000),
  /** Estimated token ceiling for state plus one batch of questions. */
  maxRequestTokens: z.natural().default(30000),
  /** Characters of a dropped tool result kept as a head. */
  truncateHeadChars: z.natural().default(300),
  /** A saving below this fraction is not worth the risk; fall back. */
  minReductionRatio: z.number().default(0.15),
  /** ...and neither is an absolute saving below this many estimated tokens. */
  minTokensSaved: z.natural().default(500),
  /** Keeps a hung Jev socket off the compaction path. */
  jevTimeoutMs: z.natural().default(5000),
  jevModel: z.string().default('jev-latest'),
  /** Empty = ~/.dsh/context-curator/curator.jsonl */
  logPath: z.string().default(''),
  logEnabled: z.boolean().default(true),
});

/** The routed model's last reported usage, for the cache-cost ledger. */
function latestUsage(session) {
  try {
    const nodes = session?.surface?.nodes ?? [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index]);
      const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined;
      if (usage === undefined || usage === null) continue;
      return {
        input_tokens: usage.inputTokens ?? null,
        output_tokens: usage.outputTokens ?? null,
        cache_read_tokens: usage.cacheReadTokens ?? null,
        cache_write_tokens: usage.cacheWriteTokens ?? null,
      };
    }
  } catch {
    /* a diagnostic read must never be the reason compaction fails */
  }
  return null;
}

function countReasons(decisions, reason) {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Replace `compaction-basic` while keeping every behaviour it owns.
 *
 * The constructor passes an EMPTY config to the base class on purpose: the
 * trigger thresholds, retry counts and retention ratios stay exactly what the
 * preset already had, so turning this plugin on cannot silently change when DSH
 * decides to compact. Only the summarizer changes.
 */
export class ContextCuratorEngine extends BasicCompactionEngine {
  static Config = Config;

  constructor(ctx, config = {}) {
    // The base class is handed its OWN schema's defaults rather than `{}`, so
    // the trigger thresholds, retry counts and `auto` flag are byte-identical to
    // what DSH resolved for the stock `compaction-basic` row this plugin
    // replaces. Turning the curator on must not move the moment DSH compacts.
    super(ctx, BasicCompactionEngine.Config({}));
    const settings = { ...config };
    this.curator = {
      enabled: settings.enabled !== false,
      adopt: settings.adopt === true,
      keepThreshold: Number.isFinite(settings.keepThreshold)
        ? settings.keepThreshold
        : KEEP_THRESHOLD_DEFAULT,
      preserveRecentMessages: Number.isFinite(settings.preserveRecentMessages)
        ? settings.preserveRecentMessages
        : 6,
      maxStateTokens: Number.isFinite(settings.maxStateTokens) ? settings.maxStateTokens : 25000,
      maxRequestTokens: Number.isFinite(settings.maxRequestTokens) ? settings.maxRequestTokens : 30000,
      truncateHeadChars: Number.isFinite(settings.truncateHeadChars) ? settings.truncateHeadChars : 300,
      minReductionRatio: Number.isFinite(settings.minReductionRatio) ? settings.minReductionRatio : 0.15,
      minTokensSaved: Number.isFinite(settings.minTokensSaved) ? settings.minTokensSaved : 500,
      jevTimeoutMs: Number.isFinite(settings.jevTimeoutMs) ? settings.jevTimeoutMs : 5000,
      jevModel: typeof settings.jevModel === 'string' && settings.jevModel.length > 0 ? settings.jevModel : 'jev-latest',
      logPath: typeof settings.logPath === 'string' ? settings.logPath : '',
      logEnabled: settings.logEnabled !== false,
    };

    const keyInfo = resolveApiKey();
    const log = new CuratorLog({
      path: this.curator.logPath,
      enabled: this.curator.logEnabled,
      apiKey: keyInfo.key,
    });
    this.diagnostics = {
      startedAt: new Date().toISOString(),
      attempts: 0,
      adopted: 0,
      fallbacks: 0,
      lastFallback: null,
      lastJev: null,
      lastRow: null,
      apiKeyPresent: keyInfo.key.length > 0,
      apiKeySource: keyInfo.source,
      apiKeyFilePath: keyInfo.filePath,
      lastError: null,
      rejected: 0,
    };
    this.log = log;
    this.apiKey = keyInfo.key;
    const scrub = (text) => redact(String(text ?? ''), this.apiKey);
    // Also reachable as a method: the tool/command handlers close over `scrub`,
    // but `summarize()` runs with `this` bound to the engine and cannot see
    // that closure. Missing this in the failure path is how a scrub mistake
    // turns "log the reason" into "throw out of summarize and fail compaction".
    this.scrub = scrub;

    ctx.logger?.info?.(
      `${PLUGIN}: ${this.curator.adopt ? 'ACTIVE (may replace DSH summaries)' : 'SHADOW (logs only, DSH still summarizes)'}` +
        `, log ${log.path}, key ${keyInfo.source}`,
    );

    // ── Read-only status, for both the model and the person ──────────────────
    if (ctx.inject !== undefined) {
      ctx.inject(['tools'], (scope) => {
        scope.tools.register({
          name: 'jev_compaction_status',
          description:
            'Report the Jev context curator state: whether it is enabled, whether it is in shadow or ' +
            'active mode, the last compaction attempt (tokens and characters before/after, reduction ' +
            'ratio, keep/drop counts, Jev latency) and why any attempt fell back to DSH native ' +
            'compaction. Also reports cache read/write tokens so the saving can be weighed against a ' +
            'prompt-cache rewrite. Read-only: it writes no rows, calls no model, changes no decision.',
          parameters: {
            type: 'object',
            properties: {
              limit: {
                type: 'integer',
                description: `How many recent compaction attempts to summarise. Default 50, clamped to 1..${MAX_HEALTH_LIMIT}.`,
              },
            },
            required: [],
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          // Arrow on purpose: the enclosing `ctx.inject(['tools'], (scope) => …)`
          // callback captured the engine, and a method shorthand would rebind
          // `this` to this tool object the moment DSH calls `tool.execute(args)`
          // — which is how `buildReport` used to receive `config === undefined`.
          execute: async (args) => {
            try {
              return renderReport(buildReport({ log, diagnostics: this.diagnostics, config: this.curator, limit: args?.limit }));
            } catch (error) {
              return [
                'Jev Context Curator',
                '',
                'Status: UNAVAILABLE',
                `- the log at ${log.path} could not be summarised: ${scrub(String(error?.message ?? error))}`,
              ].join('\n');
            }
          },
        });
      });

      ctx.inject(['commands'], (scope) => {
        scope.commands.register({
          name: 'curator',
          description: 'Context curator: recent Jev compaction health summary',
          input: { hint: '[limit]  e.g. /curator 100' },
          handler: (invocation) => {
            const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
            if (raw.length > 0 && !/^[0-9]+$/.test(raw)) {
              return {
                kind: 'error',
                text:
                  'Usage: /curator [limit]\n' +
                  `  limit is a whole number of recent attempts (1..${MAX_HEALTH_LIMIT}). Example: /curator 100`,
              };
            }
            try {
              return {
                kind: 'success',
                text: renderReport(
                  buildReport({
                    log,
                    diagnostics: this.diagnostics,
                    config: this.curator,
                    limit: raw.length === 0 ? undefined : Number(raw),
                  }),
                ),
              };
            } catch (error) {
              return {
                kind: 'error',
                text: `The log at ${log.path} could not be summarised: ${scrub(String(error?.message ?? error))}`,
              };
            }
          },
        });
      });
    }
  }

  /**
   * The single override. Returns either the Jev-built verbatim checkpoint or —
   * for every uncertain path — DSH's own summarization of the same span.
   */
  async summarize(input, agent, signal) {
    const started = Date.now();
    const session = agent?.session ?? null;
    const row = {
      at: new Date().toISOString(),
      pid: process.pid,
      process_started_at: this.diagnostics.startedAt,
      session_id: typeof session?.id === 'string' ? session.id : null,
      mode: this.curator.adopt ? 'active' : 'shadow',
      curator_v: CURATOR_VERSION,
      core_v: CORE_VERSION,
      keep_threshold: this.curator.keepThreshold,
      preserve_recent: this.curator.preserveRecentMessages,
      jev_model_requested: this.curator.jevModel,
    };
    const usage = latestUsage(session);
    if (usage !== null) row.usage = usage;

    this.diagnostics.attempts += 1;

    const finish = (extra) => {
      const complete = { ...row, ...extra, ms: Date.now() - started };
      if (complete.fallback !== undefined && complete.fallback !== null) {
        this.diagnostics.fallbacks += 1;
        this.diagnostics.lastFallback = complete.fallback;
      }
      if (complete.adopted === true) this.diagnostics.adopted += 1;
      this.diagnostics.lastRow = {
        at: complete.at,
        adopted: complete.adopted === true,
        reduction_ratio: complete.reduction_ratio ?? null,
        fallback: complete.fallback ?? null,
        tokens_before: complete.tokens_before ?? null,
        tokens_after: complete.tokens_after ?? null,
      };
      // `this.log`, not the constructor's `log`: `finish` runs with the engine as
      // its receiver and cannot see the constructor scope.
      this.log.append(complete);
      return complete;
    };

    /** Hand the span back to DSH, recording why. */
    const fallbackToDsh = async (reason, detail, partial) => {
      finish({ ...partial, adopted: false, fallback: reason, fallback_detail: detail ?? null });
      return super.summarize(input, agent, signal);
    };

    try {
      if (!this.curator.enabled) return await fallbackToDsh('disabled', null);

      const messages = input?.messages ?? [];
      const converted = fromDsh(messages);
      if (converted.messages.length === 0) return await fallbackToDsh('empty_span', null);

      const risks = [...converted.risks, ...pairingRisks(converted.messages)];
      if (risks.length > 0) return await fallbackToDsh('pairing_risk', risks[0]);

      const preserve = this.curator.preserveRecentMessages;
      const calls = collectToolCalls(converted.messages, preserve);
      const candidates = calls.filter(
        (call) => !call.pinned && !converted.protectedCallIds.has(call.tool_use_id),
      );
      row.calls = calls.length;
      row.candidates = candidates.length;
      row.pinned = calls.filter((call) => call.pinned).length;
      row.protected_results = converted.protectedCallIds.size;
      if (candidates.length === 0) {
        return await fallbackToDsh('no_candidates', `${calls.length} paired calls, all pinned or protected`);
      }
      if (signal?.aborted === true) return await fallbackToDsh('cancelled', null);

      if (this.apiKey.length === 0) return await fallbackToDsh('no_key', this.diagnostics.apiKeyFilePath);

      const jev = { requests: 0, latency_ms: 0, model: null };
      const asker = {
        ask: async (state, questions) => {
          const answered = await ask({
            apiKey: this.apiKey,
            model: this.curator.jevModel,
            timeoutMs: this.curator.jevTimeoutMs,
            signal,
            state,
            questions,
          });
          jev.requests += 1;
          jev.latency_ms += answered.latencyMs;
          if (answered.model !== null) jev.model = answered.model;
          this.diagnostics.lastJev = { model: answered.model, latencyMs: answered.latencyMs, at: new Date().toISOString() };
          return answered.response;
        },
      };

      const result = await compact(converted.messages, asker, {
        preserveRecentMessages: preserve,
        keepThreshold: this.curator.keepThreshold,
        maxStateTokens: this.curator.maxStateTokens,
        maxRequestTokens: this.curator.maxRequestTokens,
        truncateHeadChars: this.curator.truncateHeadChars,
      });
      row.jev = jev;
      row.state_tokens = result.stats.stateTokens;
      row.state_stage = result.stats.stateStage;
      row.requests = result.stats.requests;
      row.jev_latency_ms = jev.latency_ms;

      // A result holding an image or a file cannot be reproduced by re-running
      // the tool, so Jev does not get to delete it — no matter how confident it
      // was. Upstream tracks exactly this as its own open issue.
      const decisions = result.decisions.map((decision) => {
        if (decision.action === 'keep') return decision;
        const call = calls.find((candidate) => candidate.id === decision.id);
        if (call === undefined || !converted.protectedCallIds.has(call.tool_use_id)) return decision;
        return { ...decision, action: 'keep', reason: 'protected' };
      });
      const kept = applyDecisions(
        converted.messages,
        decisions,
        calls,
        this.curator.truncateHeadChars,
      );

      const charsBefore = converted.messages.reduce((sum, message) => sum + messageChars(message), 0);
      const charsAfter = kept.reduce((sum, message) => sum + messageChars(message), 0);
      const ratio = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
      const view = renderCompacted(kept);
      const tokensBefore = estimateTokens(renderCompacted(converted.messages));
      const tokensAfter = estimateTokens(view);

      row.decisions = decisions.map((decision) => ({
        id: decision.id,
        tool: decision.tool,
        keep_call: decision.keepCall,
        keep_result: decision.keepResult,
        action: decision.action,
        reason: decision.reason,
      }));
      row.kept = countReasons(decisions, 'kept');
      row.drop_result = countReasons(decisions, 'result_dropped');
      row.drop_call = countReasons(decisions, 'call_dropped');
      row.protected = countReasons(decisions, 'protected');
      row.messages_before = converted.messages.length;
      row.messages_after = kept.length;
      row.chars_before = charsBefore;
      row.chars_after = charsAfter;
      row.tokens_before = tokensBefore;
      row.tokens_after = tokensAfter;
      row.reduction_ratio = Number(ratio.toFixed(4));
      row.checkpoint_chars = view.length;

      const partial = { ...row };
      if (ratio < this.curator.minReductionRatio) {
        return await fallbackToDsh('low_reduction', `${(ratio * 100).toFixed(1)}% < ${(this.curator.minReductionRatio * 100).toFixed(1)}%`, partial);
      }
      if (tokensBefore - tokensAfter < this.curator.minTokensSaved) {
        return await fallbackToDsh('not_smaller', `${tokensBefore - tokensAfter} estimated tokens saved`, partial);
      }

      if (!this.curator.adopt) {
        // SHADOW: the decisions above are the whole point of this run; DSH still
        // produces the checkpoint the session continues from.
        return await fallbackToDsh('shadow_mode', 'adopt: false — decisions logged, DSH summary used', partial);
      }

      finish({ ...partial, adopted: true, fallback: null, checkpoint_tokens: tokensAfter });
      return {
        summary: [{ type: 'text', text: view }],
        provider: 'typesafe',
        model: jev.model ?? this.curator.jevModel,
        llmStreamCall: false,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    } catch (error) {
      // Every one of these ends the same way: DSH compacts the span itself.
      const kind =
        error instanceof JevError
          ? error.kind === 'no_key'
            ? 'no_key'
            : error.kind === 'timeout'
              ? 'jev_timeout'
              : error.kind === 'cancelled'
                ? 'cancelled'
                : 'jev_error'
          : 'internal_error';
      this.diagnostics.lastError = this.scrub(String(error?.message ?? error));
      if (error instanceof JevError) this.diagnostics.rejected += 1;
      return await fallbackToDsh(kind, this.scrub(String(error?.message ?? error)), {
        calls: row.calls ?? null,
        candidates: row.candidates ?? null,
      });
    }
  }
}

export default ContextCuratorEngine;
