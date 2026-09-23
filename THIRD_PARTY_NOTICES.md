# Third-party notices

## fast-jev-compaction

Parts of this plugin are a direct port of the compaction core of
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT, `Copyright (c) 2025`), taken at commit
`e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (version 0.2.0).

Ported verbatim into `lib/vendor/` (TypeScript types removed, JSDoc kept):

| Upstream | Here | Content |
|---|---|---|
| `src/types.ts` | `lib/vendor/vendor.types.js` | the data vocabulary, as JSDoc typedefs |
| `src/state.js` | `lib/vendor/state.js` | token estimate, tool-call collection and pairing, `fitState` |
| `src/compact.js` | `lib/vendor/compact.js` | batching, the two `noul` questions per call, `decideCall` (KEEP / DROP_RESULT / DROP_CALL), `applyDecisions`, `reductionRatio` |
| `src/request.js` | `lib/vendor/request.js` | Jev request envelope, response validation, `noulAnswer` |

Deliberately NOT ported: `hooks/fast-jev.ts` and `.claude-plugin/` (the Claude
Code hook adapter), and `src/client.ts` / `src/messages.ts` (thin fetch
wrappers — DSH uses its own Jev client so the key, the timeout and the log
redaction stay shared with `dsh-completion-supervisor`).

Changes made while porting are limited to: TypeScript type syntax removal, import
paths, and the exported-constant surface. The decision structure, the fitting
stages and the batching rule are unmodified; where this plugin differs (threshold
defaults, pinning, fallbacks) it differs in the code that CALLS the ported core,
not inside it.

## Original license

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
