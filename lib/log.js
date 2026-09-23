/**
 * The append-only JSONL behind `jev_compaction_status`.
 *
 * One row per compaction attempt, written AFTER the outcome is known, so a row
 * always describes something that finished. Writing is best-effort: a failed
 * append increments a counter and never throws into the compaction path, because
 * losing an observation must not break a session.
 *
 * The key is redacted on the way in. A row is not allowed to be the thing that
 * leaks the credential.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redact } from './jev.js';

export const LOG_VERSION = 1;

export function defaultLogPath() {
  return join(homedir(), '.dsh', 'context-curator', 'curator.jsonl');
}

export class CuratorLog {
  constructor(options = {}) {
    this.path =
      typeof options.path === 'string' && options.path.trim().length > 0
        ? options.path
        : defaultLogPath();
    this.enabled = options.enabled !== false;
    this.apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    this.writeFailures = 0;
    this.redactions = 0;
    this.lastError = null;
    this.rows = 0;
  }

  /** @returns {boolean} whether the row reached the file */
  append(row) {
    this.rows += 1;
    if (!this.enabled) return false;
    let line;
    try {
      line = JSON.stringify({ log_v: LOG_VERSION, ...row });
    } catch (error) {
      this.lastError = `row was not serialisable: ${String(error?.message ?? error)}`;
      return false;
    }
    const cleaned = redact(line, this.apiKey);
    if (cleaned !== line) this.redactions += 1;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${cleaned}\n`, 'utf8');
      return true;
    } catch (error) {
      this.writeFailures += 1;
      this.lastError = String(error?.message ?? error);
      return false;
    }
  }

  /**
   * Read the tail of the log. Never throws: a missing or unreadable file is
   * "no data", and one corrupt line is skipped rather than failing the read.
   * @returns {{rows: object[], corrupt: number, missing: boolean, error: string|null, bytes: number}}
   */
  read(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50;
    let body = '';
    try {
      body = readFileSync(this.path, 'utf8');
    } catch (error) {
      const missing = error?.code === 'ENOENT';
      return {
        rows: [],
        corrupt: 0,
        missing,
        error: missing ? null : String(error?.message ?? error),
        bytes: 0,
      };
    }
    const lines = body.split('\n').filter((line) => line.trim().length > 0);
    const tail = lines.slice(-limit);
    const rows = [];
    let corrupt = 0;
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') rows.push(parsed);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
    return { rows, corrupt, missing: false, error: null, bytes: body.length };
  }
}
