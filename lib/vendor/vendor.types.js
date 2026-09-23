/**
 * The data vocabulary of the ported compaction core.
 *
 * Upstream this file was `src/types.ts`; the interfaces are TypeScript-only and
 * are carried here as JSDoc typedefs so the JS port needs no build step. The
 * field names are the upstream ones and are load-bearing: `tool_use_id` is what
 * pairs a call with its result, and `call.id` (`t1`, `t2`, ...) is what names
 * the two Jev questions asked about it.
 *
 * @typedef {'user'|'assistant'} Role
 *
 * @typedef {object} ToolUse
 * @property {string} tool_use_id
 * @property {string} tool
 * @property {Record<string, unknown>} input
 * @property {string} [text]        result text, once the transcript holds it
 * @property {boolean} [isError]
 *
 * @typedef {object} ToolResult
 * @property {string} tool_use_id
 * @property {string} text
 * @property {boolean} [isError]
 *
 * @typedef {object} Message
 * @property {Role} role
 * @property {string} text
 * @property {ToolUse[]} toolUses
 * @property {ToolResult[]} [toolResults]
 *
 * @typedef {object} ToolCall
 * @property {string} id              short id used in the state and question names
 * @property {string} tool_use_id
 * @property {string} tool
 * @property {Record<string, unknown>} input
 * @property {number} callIndex       message index holding the tool_use block
 * @property {number} resultIndex     message index holding the tool_result block
 * @property {number} resultChars
 * @property {boolean} isError
 * @property {boolean} pinned         first or newest preserved message; never a candidate
 *
 * @typedef {object} CallAnswer
 * @property {number} keepCall    Jev's probability that the call itself still matters
 * @property {number} keepResult  Jev's probability that the full result stays verbatim
 *
 * @typedef {'keep'|'drop_result'|'drop_call'} CallAction
 *
 * @typedef {object} CallDecision
 * @property {string} id
 * @property {string} tool
 * @property {number} keepCall
 * @property {number} keepResult
 * @property {CallAction} action
 * @property {'pinned'|'kept'|'result_dropped'|'call_dropped'} reason
 *
 * @typedef {object} CompactionState
 * @property {string} context
 * @property {string} goal
 * @property {object[]} history
 *
 * @typedef {object} FittedState
 * @property {CompactionState} state
 * @property {number} tokens
 * @property {string} stage   which fitting stage produced the state
 *
 * @typedef {object} CompactOptions
 * @property {string} [goal]
 * @property {number} [keepThreshold]
 * @property {number} [preserveRecentMessages]
 * @property {number} [maxStateTokens]
 * @property {number} [maxRequestTokens]
 * @property {number} [truncateHeadChars]
 *
 * @typedef {object} ResolvedCompactOptions
 * @property {string} goal
 * @property {number} keepThreshold
 * @property {number} preserveRecentMessages
 * @property {number} maxStateTokens
 * @property {number} maxRequestTokens
 * @property {number} truncateHeadChars
 *
 * @typedef {object} CompactStats
 * @property {number} messagesBefore
 * @property {number} messagesAfter
 * @property {number} charsBefore
 * @property {number} charsAfter
 * @property {number} calls
 * @property {number} kept
 * @property {number} resultsDropped
 * @property {number} callsDropped
 * @property {number} pinned
 * @property {number} stateTokens
 * @property {string} stateStage
 * @property {number} requests
 * @property {number} ms
 *
 * @typedef {object} CompactResult
 * @property {Message[]} messages
 * @property {CallDecision[]} decisions
 * @property {CompactStats} stats
 *
 * @typedef {object} JevAsker
 * @property {(state: string|object, questions: object) => Promise<object>} ask
 */

export {};
