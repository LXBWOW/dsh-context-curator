# dsh-context-curator

[简体中文](README.md) | **English**

A context-compaction backend for DSH: **delete stale tool junk, keep everything else verbatim**.

It is a drop-in replacement for `@deepseek-ai/dsh-compaction-basic` (one line changed in the compaction group). It inherits that package's trigger timing, retention policy, log transaction and surface replacement wholesale, and overrides only the single hook its documentation allows to be overridden:

    summarize(input, agent, signal)

Upstream lets the model **rewrite the whole history into a summary** at that point. This plugin instead asks Jev (a fast classifier, not an LLM) two questions — "is this call still needed?" and "does this output still need to be kept verbatim?" — and deletes only what it is sure about. The user's own words and the assistant's prose that survive enter the checkpoint **verbatim**: not rewritten, not condensed.

The core algorithm is ported directly from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT, commit `e3f262a`); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Current status: shadow (records only, never adopts)

Default is `adopt: false`: the whole pipeline runs, decisions, probabilities and savings all go to the log, but what is handed back to DSH is still DSH's own summary. So switching it on today leaves behaviour **exactly as before**, with one extra log. Change it to `adopt: true` once you have seen enough.

## Install (three steps)

1. Set up dependency resolution (the plugin's own imports must resolve against the installed DSH):

       node tools/link-deps.mjs

2. Generate the preset (copies the shipped `standard` and changes only the compaction line):

       node tools/install-preset.mjs

   It writes to `~/.dsh/.agent-presets/context-curator/` and appears in DSH's preset list as "标准模式 + 上下文整理（Jev）" (Standard mode + context curation (Jev)).

3. Restart DSH, pick that preset for a new session, trigger one compaction, then type `/curator`.

## Configuration

Written under `config:` on that one line in the preset file, for example:

    - id: context-curator
      name: 'C:/.../dsh-context-curator/lib/index.js'
      config:
        adopt: true

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn it off for pure pass-through |
| `adopt` | `false` | false = shadow; true = use Jev's checkpoint when the saving is large enough |
| `keepThreshold` | `0.4` | Minimum probability required to keep a call / result |
| `preserveRecentMessages` | `6` | The most recent N messages are never touched (the first message of the span is never touched either) |
| `maxStateTokens` | `25000` | Estimated cap on the state sent to Jev |
| `maxRequestTokens` | `30000` | Cap on state + one batch of questions |
| `truncateHeadChars` | `300` | How many characters of the head a truncated result keeps |
| `minReductionRatio` | `0.15` | Below this ratio the result is not adopted |
| `minTokensSaved` | `500` | Below this absolute saving it is not adopted either |
| `jevTimeoutMs` | `5000` | Jev timeout |
| `jevModel` | `jev-latest` | Model alias |
| `logPath` | empty | empty = `~/.dsh/context-curator/curator.jsonl` |
| `logEnabled` | `true` | Off means in-memory counters only |

### Why the threshold is not upstream's 0.5

Upstream uses 0.5, and its own issue tracker carries public doubts about that number and the probability scale behind it; our Jev is not necessarily the one it was calibrated against either. Every log line this plugin writes records **both raw probabilities** (`keep_call` / `keep_result`), so the threshold can be moved on evidence later rather than on guesswork. The low default is deliberate: a low threshold means "keep it when Jev is unsure", and keeping only costs tokens, whereas deleting wrongly cannot be undone.

## The safety rules it copied

- The first message of the span is always kept (the user's original constraints usually live there)
- The most recent `preserveRecentMessages` messages are always kept
- Ordinary user and assistant text is never deleted and never rewritten
- Tool calls and results are handled as pairs by `tool_use_id`, never half-deleted
- Results containing images or attachments are **force-kept** — re-running a tool does not necessarily return the same bytes
- Anything uncertain → keep

## When it falls back to DSH's native compaction

If any one condition holds, this compaction is handed back to `super.summarize()` — i.e. what DSH would have done anyway — and the agent cannot tell:

| `fallback` in the log | Trigger |
|---|---|
| `shadow_mode` | `adopt: false`, the default |
| `disabled` | `enabled: false` |
| `empty_span` | no processable messages in this span |
| `pairing_risk` | orphan result, duplicate result, result earlier than its call |
| `no_candidates` | every call is pinned or protected |
| `no_key` | `TYPESAFE_API_KEY` not found |
| `jev_timeout` / `jev_error` / `malformed` | Jev unavailable or answering illegally |
| `low_reduction` | saving ratio below `minReductionRatio` |
| `not_smaller` | absolute saving below `minTokensSaved` |
| `cancelled` | the compaction was cancelled |
| `internal_error` | this plugin itself has a bug |

A crash, a timeout or a bad response always degrades to "nothing was curated", never to "the session is broken".

## How it relates to two other plugins

- **Completely independent of Completion Supervisor**: that one judges "is the work really finished", this one judges "is the context too fat". They share only the Jev key, endpoint and log redaction; policy and state are separate and neither reads the other's.
- **Complementary to, not in conflict with, tool-result-pruner**: that one handles a single oversized result first (`thresholdChars: 8192`), this one handles "old results across many turns going stale as a group". The original backend calls the pruner before compacting, and this plugin keeps that step.

## Known boundaries

- **The preset is a snapshot**: `install-preset.mjs` copies the shipped `standard`, and a DSH upgrade will not update that copy automatically (`dsh-agent-presets` has no "patch one line" semantics). Re-run the script after an upgrade to refresh it.
- **Absolute paths**: the preset references this plugin by absolute path (a bare package name can only resolve from the harness's `node_modules`). Moving the directory means re-running the install script.
- **`reasoning` blocks are outside the scope**: neither counted nor kept; they are not the history needed to resume work.
- **The cache may be rewritten**: replacing older history invalidates the provider's prompt cache from the first changed token onwards. Both the log and `/curator` record `cache_read_tokens` / `cache_write_tokens` for the most recent request, so you can check whether the money saved by sending less context was cancelled out by the cache rewrite.
- **What it does not do**: no proactive per-turn pruning, no calling Jev on every tool result, no periodic background curation, no rewriting of long-lived session files (the original events are still in the log, and a replay can still reconstruct the truth).

## Three-phase verification (the order cannot be swapped)

**There is one easy mistake here**: with `adopt: false`, Jev's result is never sent to the model at all — DSH still submits its own summary. So the shadow phase **cannot test** "the context really got smaller", "the key context is still there" or "the agent can still keep working"; those three only exist once adoption is on. All the shadow phase can test is the pipeline itself.

### Phase 1: shadow, verify the pipeline

Pick "Standard mode + context curation (Jev)" for a new session, keep `adopt: false`, drive a real session long enough to trigger one compaction, then:

    node tools/shadow-check.mjs      # or type /curator

Check item by item: plugin loaded, `summarize()` called, Jev request succeeded, before/after tokens, reduction ratio, KEEP/DROP_RESULT/DROP_CALL, pin count, pairing risk-free, cache tokens recorded, and `fallback` being only `shadow_mode`. The script explicitly marks the three things shadow cannot test as NOT EXERCISED rather than counting them as passed.

### Phase 2: adopt, verify the three success criteria

Once phase 1 is clean, change that preset line to `adopt: true`, restart, run another long session, then judge:

1. the context is clearly smaller (`/curator`'s before -> after);
2. the key constraints, the current error and the latest tool results are still present (cross-check against `decisions`: what was deleted should only be stale tool output);
3. after compaction the agent can still keep working correctly.

This phase is also the first one that actually exercises the `provider: typesafe` and `usage` fields of the `compaction/summary` event — in the shadow phase those fields came from DSH itself and could not fail.

### Phase 3: fallback smoke

Without touching any code, inject one failure through configuration alone: set `jevTimeoutMs` to `1` temporarily (a guaranteed timeout), restart, trigger one compaction, and confirm that line in `/curator` has `fallback` = `jev_timeout` and that the session continues as usual (DSH's own summary takes over). Delete `jevTimeoutMs` afterwards to restore the default.

If all three hold, move on to normal use and observation; if any one fails, switch `adopt` back to false and keep the log as evidence.

## Development

    npm test                  # core behaviour: adapter, tri-state decision, fallback, rendering
    node tools/demo.mjs       # offline end-to-end: one simulated span through the whole pipeline
    node tools/preflight.mjs  # preflight the real code path: construction under a real cordis Context, one real Jev round trip,
                              # shadow / adopt / timeout fallback, log fields and redaction (the log goes to a temp directory)
    node tools/shadow-check.mjs  # checklist after the first real run (reads ~/.dsh/context-curator/curator.jsonl)
    node tools/link-deps.mjs --check
    node tools/install-preset.mjs --check

`/curator [limit]` and the `jev_compaction_status` tool share one report builder, and both are read-only: they write no log, call no Jev and change no decision.
