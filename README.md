# autorefactor-ai

A token-efficient, agentic refactoring CLI for legacy JavaScript/TypeScript. It
finds what is worth fixing, asks an LLM for a **minimal patch per function**
(not per file), checks each patch with real tools, retries with the real error
if a check fails, and commits every verified fix as its own commit.

```
autorefactor analyze ./src          # read-only: what would change, and why
autorefactor run ./src              # fix, verify, retry, commit
autorefactor check-llm              # one test call: is my key/model working?
```

## Install

```bash
npm install -g autorefactor-ai       # requires Node 18.18+
autorefactor --version
```

From a clone: `npm install && npm run build && npm link`.

## Quick start (free Gemini key)

1. Get a key at <https://aistudio.google.com/app/apikey>.
2. Put settings in `~/.autorefactor/.env` (read from anywhere) or in a `.env`
   in the folder you run from (takes priority):
   ```
   LLM_PROVIDER=google
   GOOGLE_GENERATIVE_AI_API_KEY=your-key
   LLM_MODEL_CHEAP=gemini-3.5-flash-lite
   LLM_MODEL_CAPABLE=gemini-3.8-flash
   ```
   Model names change and old ones are retired; confirm them in AI Studio.
3. `autorefactor check-llm` — confirms the key and model work.
4. `autorefactor analyze ./src`, then `autorefactor run ./src --no-git`.

> Free tiers may use your prompts to improve the provider's products. Don't run
> them on confidential code. Secret-shaped strings (API keys, tokens) are
> redacted before anything is sent, but proprietary logic is not.

## Commands

| Command | What it does |
| --- | --- |
| `analyze <target>` | Lists findings, processing order, which fixes clear the priority threshold, and an estimate of tokens. Never calls an LLM or changes a file. |
| `run <target>` | The full pipeline. Refuses to start if your LLM settings are missing or the git tree has uncommitted changes. |
| `check-llm [cheap\|capable]` | One small call with your settings; prints timing, tokens, retries, or the exact API error. |

`run` options: `--no-git` (apply patches without branching/committing),
`--run-tests` (also run the target's own Jest suite as a verification step),
`--max-retries <n>` (default 3), `--min-score <n>` (priority threshold, default 15).

With git on, fixes go to a new `agent/refactor-<timestamp>` branch, one commit
per fix, and a markdown report is written to `.autorefactor-work/`.

## How it works

1. **Parse** — builds a syntax tree per file (ts-morph), detects smells
   (untyped signatures, callback nesting, `var`, missing error handling, high
   cyclomatic complexity).
2. **Order** — builds the import graph and fixes dependencies before their users.
3. **Plan** — scores each finding (complexity × impact × size × smells, dampened)
   and skips low-value ones entirely, which saves whole LLM calls.
4. **Slice** — sends only the target function plus the helpers it actually calls
   (signature only when large), not the whole file.
5. **Generate** — routes simple fixes to a cheap model and hard ones to a capable
   one; output is forced into a strict schema.
6. **Verify** — type-checks, lints (including a custom rule against a real
   callback-conversion bug), and optionally runs your tests. On failure the
   original file is restored and the real error is sent back for a retry.
7. **Deliver** — commits each verified fix; reports measured token usage.

Token use is measured from the API's own counts (`API usage (measured)`), not
only estimated.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic`, `openai` or `google` | `anthropic` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | key for the chosen provider | — |
| `LLM_MODEL_CHEAP` / `LLM_MODEL_CAPABLE` | model per tier (required for openai/google) | built in for anthropic |
| `LLM_API_RETRIES` | retries on rate limits / server errors | 5 |
| `LLM_RETRY_BASE_MS` | first backoff delay, doubles each retry | 2000 |
| `LLM_REQUEST_TIMEOUT_MS` | a single request that goes silent is aborted and retried after this long | 90000 |
| `LLM_TIMEOUT_MS` | overall cap on one call, retries and waits included | 240000 |
| `LLM_FALLBACK` | set to `off` to disable falling back from the capable model to the cheap one when it stays unavailable | on |

## Limitations

- **Verified means checked, not proven.** A patch must type-check, lint and pass
  the tests you point it at. Behaviour changes that no test covers can still
  slip through, so review the diff.
- Plain `.js` files get types as JSDoc; `.ts`/`.jsx` files are not linted
  (reported as skipped). The `--run-tests` stage supports Jest only.
- "Impact" is measured per file, not per function.
- Only the Google provider has been exercised against a live API so far.
- If the provider is down, a task fails (and is restored) rather than the run; two tasks failing that way in a row stops the run and returns you to your original branch.

## Development

```bash
npm install
npm test               # needs: cd test-target && npm install   (once)
npm run typecheck
npm run cli -- analyze test-target/src
npm run build          # compiles to dist/
npm pack --dry-run     # shows exactly what would be published
```

## License

MIT