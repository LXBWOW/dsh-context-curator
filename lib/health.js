/**
 * The read-only report behind `jev_compaction_status` and `/curator`.
 *
 * Same data, same rendering, two entry points: the tool exists so the agent can
 * check mid-investigation, the command so the person can check without spending
 * a turn. Both build the report here, so the two can never disagree.
 *
 * Strictly read-only: it opens the JSONL, writes nothing, calls no model, and
 * touches no state. Running it cannot change a decision. Every verdict below is
 * produced by a deterministic rule over the rows, never by asking a model, and
 * it never claims a decision was wrong — it reports what needs a human look.
 */

export const MAX_HEALTH_LIMIT = 500;
export const DEFAULT_HEALTH_LIMIT = 50;

function clampLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_HEALTH_LIMIT;
  return Math.min(MAX_HEALTH_LIMIT, Math.max(1, Math.floor(numeric)));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function formatPercent(value) {
  return value === null || value === undefined ? '(none)' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '(none)';
}

/**
 * Fold the rows into the numbers the first triage needs.
 * @param {{rows: object[], corrupt: number, missing: boolean, error: string|null, bytes: number}} read
 * @param {object} diagnostics - in-process counters.
 * @param {object} config - resolved curator settings.
 * @param {number|undefined} limit
 */
export function buildReport({ log, diagnostics, config, limit }) {
  const requested = limit === undefined || limit === null ? DEFAULT_HEALTH_LIMIT : limit;
  const read = log.read({ limit: clampLimit(requested) });
  const rows = read.rows;
  const last = rows.length === 0 ? null : rows[rows.length - 1];

  const adopted = rows.filter((row) => row.adopted === true);
  const fallbackReasons = new Map();
  for (const row of rows) {
    if (typeof row.fallback !== 'string' || row.fallback.length === 0) continue;
    fallbackReasons.set(row.fallback, (fallbackReasons.get(row.fallback) ?? 0) + 1);
  }
  const ratios = rows
    .map((row) => row.reduction_ratio)
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  const latencies = rows
    .map((row) => row.jev_latency_ms)
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const failureReasons = new Set(['jev_timeout', 'jev_error', 'no_key', 'malformed']);
  const failures = rows.filter((row) => failureReasons.has(row.fallback)).length;
  const saves = rows
    .map((row) =>
      typeof row.tokens_before === 'number' && typeof row.tokens_after === 'number'
        ? row.tokens_before - row.tokens_after
        : null,
    )
    .filter((value) => value !== null);

  return {
    plugin: 'dsh-context-curator',
    enabled: config.enabled !== false,
    mode: config.adopt === true ? 'active' : 'shadow',
    keepThreshold: config.keepThreshold,
    minReductionRatio: config.minReductionRatio,
    minTokensSaved: config.minTokensSaved,
    preserveRecentMessages: config.preserveRecentMessages,
    jevModelRequested: config.jevModel,
    jevTimeoutMs: config.jevTimeoutMs,
    logPath: log.path,
    logEnabled: log.enabled,
    logMissing: read.missing,
    logError: read.error,
    logCorrupt: read.corrupt,
    rowsRead: rows.length,
    readRequested: clampLimit(requested),
    last,
    inProcess: {
      attempts: diagnostics.attempts,
      adopted: diagnostics.adopted,
      fallbacks: diagnostics.fallbacks,
      lastFallback: diagnostics.lastFallback,
      lastJev: diagnostics.lastJev,
      apiKeyPresent: diagnostics.apiKeyPresent,
      apiKeySource: diagnostics.apiKeySource,
      apiKeyFilePath: diagnostics.apiKeyFilePath,
      rejected: diagnostics.rejected,
      startedAt: diagnostics.startedAt,
      lastError: diagnostics.lastError,
    },
    summary: {
      adopted: adopted.length,
      fallbacks: rows.length - adopted.length,
      fallbackReasons: [...fallbackReasons.entries()].sort((a, b) => b[1] - a[1]),
      ratioMin: ratios.length === 0 ? null : ratios[0],
      ratioMedian: percentile(ratios, 0.5),
      ratioMax: ratios.length === 0 ? null : ratios[ratios.length - 1],
      latencyMedian: percentile(latencies, 0.5),
      latencyMax: latencies.length === 0 ? null : latencies[latencies.length - 1],
      failures,
      tokensSavedTotal: saves.length === 0 ? null : saves.reduce((sum, value) => sum + value, 0),
    },
  };
}

/** Deterministic verdict. Never calls a model, never guesses intent. */
function verdictOf(report) {
  if (!report.enabled) return { code: 'OFF', note: 'the curator is disabled by config; DSH compacts natively' };
  if (report.rowsRead === 0) {
    return {
      code: 'NO_DATA',
      note: report.logMissing
        ? 'no log yet — nothing has been compacted since the plugin was installed'
        : 'the log holds no readable rows',
    };
  }
  const { summary } = report;
  if (summary.adopted === 0 && report.mode === 'shadow') {
    return {
      code: 'SHADOW',
      note: `${report.rowsRead} attempt(s) logged and none adopted — set adopt: true to use the decisions`,
    };
  }
  const failureShare = summary.failures / report.rowsRead;
  if (failureShare > 0.2) {
    return {
      code: 'CHECK',
      note: `${summary.failures} of ${report.rowsRead} attempts could not reach Jev — the key, the endpoint or the timeout needs a look`,
    };
  }
  if (report.mode === 'active' && summary.adopted > 0 && summary.ratioMedian !== null && summary.ratioMedian <= 0) {
    return { code: 'CHECK', note: 'adopted checkpoints are not smaller than what they replaced' };
  }
  return {
    code: 'OK',
    note:
      report.mode === 'active'
        ? `${summary.adopted} adopted, median reduction ${formatPercent(summary.ratioMedian)}`
        : 'shadow mode is recording decisions',
  };
}

/** Bytes of one row's before/after position, for the token ledger. */
function ledgerLines(row) {
  const lines = [];
  if (row === null) return lines;
  if (row.tokens_before !== undefined || row.tokens_after !== undefined) {
    lines.push(
      `  estimated tokens: ${formatNumber(row.tokens_before)} -> ${formatNumber(row.tokens_after)}` +
        (typeof row.tokens_before === 'number' && typeof row.tokens_after === 'number'
          ? `  (${formatNumber(row.tokens_before - row.tokens_after)} saved, ${formatPercent(row.reduction_ratio)} smaller)`
          : ''),
    );
  }
  if (row.chars_before !== undefined || row.chars_after !== undefined) {
    lines.push(`  characters: ${formatNumber(row.chars_before)} -> ${formatNumber(row.chars_after)}`);
  }
  if (row.messages_before !== undefined || row.messages_after !== undefined) {
    lines.push(`  messages: ${formatNumber(row.messages_before)} -> ${formatNumber(row.messages_after)}`);
  }
  return lines;
}

export function renderReport(report) {
  const verdict = verdictOf(report);
  const last = report.last;
  const lines = [
    'Jev Context Curator',
    `verdict: ${verdict.code} — ${verdict.note}`,
    '',
    `enabled: ${report.enabled}`,
    report.enabled
      ? `mode: ${report.mode === 'active' ? 'ACTIVE (a Jev checkpoint may replace DSH\'s summary)' : 'SHADOW (decisions are logged, DSH still summarizes)'}`
      : 'mode: OFF',
    `keep threshold: ${report.keepThreshold} (upstream ships 0.5; moved down on purpose so an unsure call is kept)`,
    `adoption needs: reduction >= ${formatPercent(report.minReductionRatio)} and >= ${report.minTokensSaved} tokens saved`,
    `preserved recent messages: ${report.preserveRecentMessages}`,
    `Jev: model ${report.jevModelRequested}, timeout ${report.jevTimeoutMs}ms`,
    `TYPESAFE_API_KEY present: ${report.inProcess.apiKeyPresent}`,
    report.inProcess.apiKeyPresent
      ? `  resolved from: ${report.inProcess.apiKeySource === 'file' ? `file ${report.inProcess.apiKeyFilePath}` : 'the environment'}`
      : `  looked in: the environment, then ${report.inProcess.apiKeyFilePath ?? '(no key file path)'}`,
    report.inProcess.lastJev === null
      ? '  no Jev response yet in this process'
      : `  last response came from model: ${report.inProcess.lastJev.model ?? '(the response did not name one)'} (${report.inProcess.lastJev.latencyMs}ms, at ${report.inProcess.lastJev.at})`,
    '',
    `this process: ${report.inProcess.attempts} attempt(s), ${report.inProcess.adopted} adopted, ${report.inProcess.fallbacks} fell back`,
    report.inProcess.lastFallback === null ? '' : `  most recent fallback: ${report.inProcess.lastFallback}`,
    `log: ${report.logPath}${report.logEnabled ? '' : '  (logging DISABLED)'}`,
    `  read ${report.rowsRead} of the last ${report.readRequested} row(s)${report.logCorrupt > 0 ? `, ${report.logCorrupt} unreadable line(s) skipped` : ''}`,
    report.logError === null ? '' : `  log read error: ${report.logError}`,
    '',
  ];

  if (last === null) {
    lines.push('no compaction has been recorded yet — nothing to summarise');
    return lines.filter((line) => line !== '').join('\n');
  }

  lines.push(
    'last attempt',
    `  at: ${last.at ?? '(unrecorded)'}  (recorder started ${report.inProcess.startedAt})`,
    `  session: ${last.session_id ?? '(none)'}`,
    `  mode: ${last.mode ?? '(unrecorded)'}`,
    ...ledgerLines(last),
    `  calls: ${formatNumber(last.calls)} paired (${formatNumber(last.candidates)} candidates, ${formatNumber(last.pinned)} pinned, ${formatNumber(last.protected_results)} protected result(s))`,
    `  decisions: keep ${formatNumber(last.kept)}, drop_result ${formatNumber(last.drop_result)}, drop_call ${formatNumber(last.drop_call)}${last.protected ? `, protected ${last.protected}` : ''}`,
    `  Jev: ${formatNumber(last.requests)} request(s), ${formatNumber(last.jev_latency_ms)}ms` +
      (last.state_tokens !== undefined ? `, state ~${formatNumber(last.state_tokens)} tokens (fit stage: ${last.state_stage ?? 'n/a'})` : ''),
    `  outcome: ${last.adopted === true ? 'ADOPTED' : `not adopted — ${last.fallback ?? 'unknown'}`}${last.fallback_detail ? ` (${last.fallback_detail})` : ''}`,
    '',
  );

  const usage = last.usage;
  if (usage !== undefined && usage !== null) {
    lines.push(
      'cache ledger (last routed request before this compaction)',
      `  context tokens in: ${formatNumber(usage.input_tokens)}`,
      `  cache read tokens: ${formatNumber(usage.cache_read_tokens)}`,
      `  cache write tokens: ${formatNumber(usage.cache_write_tokens)}`,
      '  read this beside the saving above: rewriting earlier history invalidates the',
      '  provider cache from the first changed token, so a token saved is not automatically',
      '  a token not paid for.',
      '',
    );
  } else {
    lines.push('cache ledger: the routed request has not reported usage yet', '');
  }

  const { summary } = report;
  lines.push(
    `over the last ${report.rowsRead} attempt(s)`,
    `  adopted: ${summary.adopted}`,
    `  reduction ratio: min ${formatPercent(summary.ratioMin)} / median ${formatPercent(summary.ratioMedian)} / max ${formatPercent(summary.ratioMax)}`,
    `  Jev latency: median ${summary.latencyMedian === null ? '(none)' : `${summary.latencyMedian}ms`} / max ${summary.latencyMax === null ? '(none)' : `${summary.latencyMax}ms`}`,
    summary.tokensSavedTotal === null ? '' : `  estimated tokens saved in total: ${formatNumber(summary.tokensSavedTotal)}`,
    summary.fallbackReasons.length === 0
      ? '  fallbacks: none'
      : `  fallbacks: ${summary.fallbackReasons.map(([reason, count]) => `${reason} ${count}`).join(', ')}`,
    '',
    'probabilities are recorded raw per call and per result on every row, so the',
    'keep threshold can be moved against evidence rather than against a guess.',
  );

  return lines.filter((line) => line !== '').join('\n');
}
