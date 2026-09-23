/**
 * The Jev transport: one POST per batch, a deadline, and a key resolved the
 * same way `dsh-completion-supervisor` resolves it so a machine has ONE place
 * to put the Typesafe key.
 *
 * Sharing the key is deliberate; sharing nothing else is also deliberate. The
 * supervisor owns a policy about finished work, this plugin owns a policy about
 * fat context, and neither reads the other's state.
 *
 * Never a single point of failure: every failure throws a typed error the
 * caller turns into a fallback to DSH's own compaction.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MODEL, buildJevRequest, parseJevResponse } from './vendor/request.js';

export const DEFAULT_TIMEOUT_MS = 5000;

export class JevError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = options.kind ?? 'request';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Strip a quoted or `export `-prefixed dotenv value. */
function parseKeyValue(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (value.startsWith('export ')) value = value.slice('export '.length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

export function readApiKeyFromEnv(env = process.env) {
  return parseKeyValue(env?.TYPESAFE_API_KEY);
}

/** `DSH_TYPESAFE_KEY_FILE` wins; otherwise the supervisor's own key file. */
export function defaultKeyFilePath(env = process.env) {
  const override = env?.DSH_TYPESAFE_KEY_FILE;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return join(homedir(), '.dsh', 'completion-supervisor', '.env');
}

/** Read the key from a dotenv file, or '' when there is nothing usable there. */
export function readApiKeyFromFile(filePath, readFile = (path) => readFileSync(path, 'utf8')) {
  let body = '';
  try {
    body = readFile(filePath);
  } catch {
    return '';
  }
  const match = /^TYPESAFE_API_KEY\s*=(.*)$/m.exec(body);
  return match ? parseKeyValue(match[1]) : '';
}

/**
 * Resolve the key once: the real environment WINS over the file, so a key
 * exported for a one-off run is never shadowed by a stale file.
 * @returns {{key: string, source: 'environment'|'file'|'none', filePath: string|null}}
 */
export function resolveApiKey(options = {}) {
  const env = options.env ?? process.env;
  const filePath = options.filePath ?? defaultKeyFilePath(env);
  const fromEnv = readApiKeyFromEnv(env);
  if (fromEnv.length > 0) return { key: fromEnv, source: 'environment', filePath: null };
  const fromFile = readApiKeyFromFile(filePath, options.readFile);
  if (fromFile.length > 0) return { key: fromFile, source: 'file', filePath };
  return { key: '', source: 'none', filePath: null };
}

/** Replace the key with a marker wherever it appears in a string. */
export function redact(text, key) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (typeof key !== 'string' || key.length < 8) return text;
  return text.split(key).join('[redacted]');
}

/**
 * Ask one batch of questions.
 * @param {{apiKey: string, model?: string, baseUrl?: string, timeoutMs?: number,
 *          signal?: AbortSignal, fetchImpl?: typeof fetch,
 *          state: string|object, questions: object}} options
 * @returns {Promise<{response: object, latencyMs: number, status: number, model: string|null}>}
 */
export async function ask(options) {
  const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
  if (apiKey.length === 0) throw new JevError('TYPESAFE_API_KEY is not configured', { kind: 'no_key' });
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new JevError('no fetch implementation available', { kind: 'no_fetch' });
  const model = options.model ?? DEFAULT_MODEL;
  const request = buildJevRequest(
    { apiKey, model, baseUrl: options.baseUrl },
    options.state,
    options.questions,
  );
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const started = Date.now();
  let response;
  try {
    response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = signal.aborted;
    throw new JevError(
      aborted ? `Jev request aborted after ${latencyMs}ms` : `Jev request failed: ${String(error?.message ?? error)}`,
      { kind: options.signal?.aborted === true ? 'cancelled' : aborted ? 'timeout' : 'network', cause: error },
    );
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = parseJevResponse(response.status, response.ok, text);
  } catch (error) {
    throw new JevError(redact(String(error?.message ?? error), apiKey), {
      kind: response.ok ? 'malformed' : 'http',
      cause: error,
    });
  }
  return {
    response: parsed,
    latencyMs: Date.now() - started,
    status: response.status,
    model: typeof parsed.model === 'string' ? parsed.model : null,
  };
}
