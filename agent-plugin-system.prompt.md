# Prompt: Replace the default agent with a plugin system (pi / codex / cursor)

> **This is a task prompt, not a plan.** It contains the goal, locked technical
> decisions, and research findings to seed the **develop** workflow. The workflow
> must first **scout** the codebase and external docs to **verify the claims
> below**, then **plan** atomic implementation tasks from those verified
> findings. Treat every factual claim in this document as something to confirm,
> not assume.

---

## 1. Goal

Replace the hard-wired dependency on `@earendil-works/pi-coding-agent` as the
**only** agent runtime with an **agent plugin system**, then ship **three**
plugins behind it:

1. **`pi-coding-agent`** — the current default, repackaged as the first plugin
   (zero behavior change for existing profiles).
2. **`codex`** — backed by the OpenAI Codex TypeScript SDK (`@openai/codex-sdk`).
3. **`cursor`** — backed by the Cursor TypeScript SDK (`@cursor/sdk`).

Objectives, in priority order:

1. **Decouple the engine from any one agent runtime.** The engine core must not
   import `pi-coding-agent` (or any concrete agent SDK) directly. A profile
   selects its runtime by an `agent:` field; the engine resolves it through a
   plugin registry.
2. **Preserve all current behavior for pi profiles.** Existing profiles (which
   omit `agent:`) keep working byte-for-byte — same model/auth resolution, same
   event fidelity, same session persistence, same structured-output path.
3. **Make codex and cursor first-class.** Both SDKs expose streaming event
   unions; each adapter translates its native events into engin's neutral
   contract so turn/tool/token/retry status flows into the existing TUI and web
   UI unchanged.

This is an **in-place refactor of `packages/engine`** plus a new plugin
boundary. It is **not** a new top-level package (unless scouting shows a cleaner
workspace split — see §7). The public surface consumed by `packages/cli` and the
TUI must stay stable.

---

## 2. Locked technical decisions (already made — do not relitigate)

### 2.1 Contract shape — thin, neutral, adapter-translated

The engine talks to every agent through a **single neutral interface**. Each
adapter owns the translation from its native events into the neutral contract.
The engine core contains **no per-agent branching** (no `switch (agentKind)` to
interpret events).

The neutral session contract (finalized names are the workflow's to pick — the
shapes below are authoritative):

```ts
// Neutral session returned by an agent plugin.
// RECOMMENDED NAME: `AgentRuntime` (NOT `AgentSession` — see §2.2).
interface AgentRuntime {
  prompt(text: string, opts?: PromptOptions): Promise<void>;
  getLastAssistantText(): string | undefined;
  getLastAssistantMessage(): LastAssistantMessage | undefined; // §2.4
  abort(): Promise<void>;
  dispose(): void;
  subscribe(cb: (e: AgentRuntimeEvent) => void): () => void; // neutral events
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly contextWindow?: number;
}

// Adapter plugin: creates a runtime for a given profile/options.
interface AgentPlugin {
  readonly id: string; // matches the profile `agent:` field, e.g. 'pi-coding-agent'
  createSession(opts: AgentSessionOptions): Promise<AgentRuntime>;
}

interface AgentSessionOptions {
  profile: AgentProfile;
  cwd: string;
  apiKeys?: Record<string, string>;
  onAgentStatus?: AgentStatusCallbacks; // §2.3
  sessionDir?: string;
  resumeSessionPath?: string;
  agentId?: string;
  allowedWriteDirs?: string[]; // §2.5
}
```

### 2.2 Naming — avoid the `AgentSession` collision

The pi adapter must import pi's **`AgentSession`** class (it wraps it). Naming
the engin neutral interface `AgentSession` would shadow/clash with that import
inside the pi adapter. **Recommend the neutral interface be named
`AgentRuntime`** and the neutral event type `AgentRuntimeEvent`. Confirm during
scouting that no existing engin type already owns these names.

### 2.3 Neutral events → `AgentStatusCallbacks`

engin already has an `AgentStatusCallbacks` surface
(`onTurnStart/onTurnEnd/onToolCallStart/onToolCallEnd/onAutoRetryStart/
onAutoRetryCompleted`) and a pure forwarder `createAgentEventForwarder` (today
keyed to pi's `AgentSessionEvent` type). **Retarget that single forwarder from
pi's event type onto a new neutral `AgentRuntimeEvent` union**, and have each
adapter's `subscribe` emit the neutral union. Net effect: one forwarder in core,
one native→neutral translation per adapter. **Do not** have each adapter
reimplement the `AgentStatusCallbacks` mapping — emit neutral events and let the
single core forwarder map them. (The neutral union should carry exactly the
fields `createAgentEventForwarder` already consumes: turn index, token usage,
content blocks, tool name/id/args/isError, retry attempt/max/delay/message.)

### 2.4 Error classification — adapter supplies `getLastAssistantMessage()`

The current `error-classifier.ts` reads pi's message schema by reaching into
`session.messages` (typed structurally as `{ messages?: unknown[] }`). This does
**not** generalize. Each adapter instead implements
`getLastAssistantMessage()` returning a neutral shape, and the classifier calls
that method rather than reading `.messages`:

```ts
interface LastAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
  content?: unknown[];
}
```

### 2.5 Write sandbox — plugin-internal enforcement

The **intent** (`allowedWriteDirs`) stays generic in the profile/options; the
**enforcement** is plugin-internal and maps to each runtime's native mechanism:

- **pi adapter:** the existing `createWriteSandboxExtension` (pi `tool_call`
  extension).
- **codex adapter:** Codex sandbox presets (e.g. `workspace_write` with writable
  roots). Verify the exact TypeScript preset API during scouting.
- **cursor adapter:** `LocalAgentOptions.sandboxOptions`. Verify the exact shape.

### 2.6 Agent config — optional `agent:` frontmatter field

Add an optional `agent:` field to profile frontmatter. **Default:
`pi-coding-agent`** when omitted (backward compatibility — existing profiles
keep working unchanged). `spawnAgent` looks up the plugin registry by this
field. Example:

```markdown
---
name: Implementer
agent: cursor # NEW (default when omitted: pi-coding-agent)
provider: anthropic
model: claude-sonnet-4
---
```

---

## 3. Current architecture — what exists (verify these during scouting)

All paths are relative to the repo root. The agent coupling is **entirely
contained in `packages/engine`** — verify that no other package
(`cli`/`tui`/`web`/`shared`) imports `pi-coding-agent`.

### 3.1 Dependency boundary

- `packages/engine/package.json` declares `@earendil-works/pi-coding-agent`
  (`^0.79.7`) as a dependency. Verify it is the **only** package that does.
- The TUI depends on a **separate** package `@earendil-works/pi-tui` (`^0.79.7`)
  — that is a different library and is **out of scope** for this work. Do not
  touch `pi-tui`.

### 3.2 Direct `pi-coding-agent` / `pi-ai` imports in engine (verify the list)

Scout should reproduce this list and confirm there are no others:

- `packages/engine/src/core/agent-loop.ts` — `import type { AgentSession }`.
- `packages/engine/src/core/agent-lifecycle.ts` — `import type { AgentSession }`.
- `packages/engine/src/core/harness-factory.ts` — `getModel` (from `pi-ai`),
  and `AgentSession`, `AgentSessionEvent`, `AuthStorage`, `createAgentSession`,
  `DefaultResourceLoader`, `SessionManager` (from `pi-coding-agent`).
- `packages/engine/src/core/write-sandbox.ts` — `ExtensionFactory`,
  `ToolCallEvent`, `isToolCallEventType` (from `pi-coding-agent`).
- `packages/engine/src/core/types.ts` — re-exports `AgentSession`, `AuthStorage`,
  `DefaultResourceLoader`, `SessionManager`; re-exports `getModel`,
  `parseJsonWithRepair`, `Model` (from `pi-ai`); imports `ThinkingLevel` (from
  `pi-agent-core`).
- `packages/engine/src/core/error-classifier.ts` — `isContextOverflow`,
  `AssistantMessage` (from `pi-ai`); reads `session.messages` structurally.
- `packages/engine/src/core/structured-output.ts` — `parseJsonWithRepair`
  (from `pi-ai`).

> `parseJsonWithRepair`, `isContextOverflow`, and the `AssistantMessage`/
> `ThinkingLevel`/`Model` types come from `pi-ai`/`pi-agent-core`, which are
> peer libs, not the agent runtime. Decide during planning whether these stay
> as engine deps (they are pure utilities/types) or move into the pi adapter —
> see §4.3.

### 3.3 The consumed `AgentSession` surface — the real contract

The pi `AgentSession` is a **class** (not an interface). Verify by reading
`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`.
But the engine consumes only a tiny subset. Scout should re-derive these usage
counts with `grep` and report the exact numbers (these seed the contract in
§2.1):

| Member                   | Approx uses across engine src | Where                                                                                 |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------- |
| `prompt(text, opts?)`    | ~14                           | `phase-tasks.ts`, `worktree-fixup.ts`, `agent-loop.ts`, tests                         |
| `getLastAssistantText()` | ~11                           | `phase-tasks.ts`, `structured-output.ts`, `validation-retry.ts`, `agent-loop.ts`      |
| `subscribe(listener)`    | ~3 (all in one place)         | **only inside `harness-factory.ts`** (the event forwarder)                            |
| `sessionFile` (getter)   | ~6                            | `agent-lifecycle.ts`, `phase-tasks.ts`, `step-execution.ts` (session path for resume) |
| `dispose()`              | ~3                            | harness teardown                                                                      |
| `abort()`                | ~2                            | cancellation / step timeout                                                           |
| `sessionId` (getter)     | ~1                            | identity                                                                              |
| `messages` (getter)      | ~1                            | `error-classifier.ts` (structural `{messages?: unknown[]}` read)                      |

**Key implication:** `subscribe()` is already centralized behind the forwarder
in `harness-factory.ts`. Moving that forwarder + the consumed subset into a
neutral interface is mechanical.

### 3.4 `createHarness` — the only session factory (verify call sites)

`createHarness` (in `harness-factory.ts`) is today's sole entry point for
creating an agent session. Verify every call site (these become the consumers of
the new `AgentPlugin.createSession`):

- `agent-loop.ts` — `parallelAgents`, `sequentialAgents`,
  `createSessionsWithCleanup`.
- `agent-lifecycle.ts` — `spawnAgent`.
- `title-generator.ts` — title generation.
- `worktree-lifecycle.ts` — merge/commit assist agents.

And `spawnAgent` (in `agent-lifecycle.ts`) is the lifecycle wrapper consumed by:

- `phase-tasks.ts` — `runStepTask`, `runMultiStepTask`.
- `pool/step-execution.ts` — `runStep`.
- `worktree-fixup.ts`.

`createHarness` returns `{ session, sessionId, dispose, contextWindow }`.
`contextWindow` comes from `getModel(profile.provider, profile.model)` (pi-ai).
For non-pi adapters `contextWindow` is optional on the neutral contract — the
adapter supplies it if it can, else `undefined`.

### 3.5 Model & auth resolution is already localized

`getModel` and `AuthStorage` are used **only** in `harness-factory.ts`. Verify
this (`rg 'getModel|AuthStorage' packages/engine/src`). This means model/auth
resolution becomes pi-adapter-internal with **zero changes to callers**. For
codex/cursor, model selection is expressed differently (see §4.4).

### 3.6 Profile config — no `agent` field today

The profile frontmatter schema (`docs/guides/profiles.md`) is:
`name, provider, model, thinkingLevel, excludeTools, includeTools`. Verify by
reading `parseProfile` in `packages/engine/src/core/profile.ts`. Every profile
**implicitly** means pi-coding-agent. This is the key config gap (§2.6).

### 3.7 Existing registry/plugin patterns to model after

engin already has two registries — mirror their style:

- `RendererRegistry` (`packages/engine/src/core/renderer-registry.ts`) — simple
  `register/get` `Map` keyed by **profile name**. Renderers are keyed by
  **profile**, orthogonal to the agent dimension.
- `HookRegistry` (`packages/engine/src/hooks/types.ts`) — a full composition
  model (`observe`/`pipeline`/`first-wins`/`all-run`).

The **agent plugin registry** should be a simple `Map` keyed by plugin `id`,
populated at engine init (built-in `pi-coding-agent` always registered; `codex`
and `cursor` registered when their packages are dependencies). Decide during
planning how the registry reaches `spawnAgent` (module-level default vs.
explicit injection through the run-executor → LanePool → spawnAgent chain).

---

## 4. Research findings — the burden & the seams (verify the claims)

### 4.1 Tests already prove a structural interface is viable

Every engine test mocks `createHarness` at the module boundary with a stub of
just `{ prompt, getLastAssistantText }` (see `phase-tasks.test.ts`,
`agent-lifecycle.test.ts`, `phase-tasks-hooks.test.ts`). Verify this. This is a
**de-facto contract** — introducing a narrow `AgentRuntime` interface won't
break the suite as long as the stubs remain structurally compatible (the stubs
will mock `AgentPlugin.createSession` instead, returning the same minimal
object).

### 4.2 The event forwarder is already agent-neutral in shape

`createAgentEventForwarder` (in `harness-factory.ts`, unit-tested in
`harness-factory.test.ts` **without** mocking pi deps) maps pi's
`AgentSessionEvent` into engin's `AgentStatusCallbacks`. It defensively coerces
numbers and captures optional strings. It is already the indirection boundary a
plugin needs. Verify it has no pi-specific logic beyond the input event type —
retargeting its input type onto `AgentRuntimeEvent` is the entire change.

### 4.3 `pi-ai` utilities vs the pi **runtime**

Separate two concerns:

- **`pi-ai` utilities** (`getModel`, `parseJsonWithRepair`,
  `isContextOverflow`, `Model`/`AssistantMessage` types) — these are pure
  helpers/types, **not** the agent runtime. `parseJsonWithRepair` feeds the
  agent-agnostic structured-output loop; `isContextOverflow` feeds the
  agent-agnostic error classifier. **These can stay as engine deps.** Verify
  `parseJsonWithRepair` and `isContextOverflow` have no pi-coding-agent
  coupling.
- **`pi-coding-agent` runtime** (`createAgentSession`, `AgentSession`,
  `AuthStorage`, `SessionManager`, `DefaultResourceLoader`, `ExtensionFactory`)
  — this is what must move behind the pi adapter.

Decision for planning: keep `pi-ai` as an engine dep (utilities + the
`LastAssistantMessage`/overflow checks stay shared), move only the
`pi-coding-agent` **runtime** symbols into the pi adapter. Confirm
`ThinkingLevel` (from `pi-agent-core`) is just a string union and can be
re-defined in engin or re-exported from `pi-ai` to drop the `pi-agent-core`
import.

### 4.4 Model selection differs per runtime (design tension to resolve)

The profile's `provider`/`model` fields are pi-centric. Verify how each target
runtime expresses model selection and decide how the adapter interprets them:

- **pi:** `getModel(profile.provider, profile.model)` + `AuthStorage`. Unchanged.
- **codex:** the SDK reportedly accepts a model at thread creation; the TS docs
  quickstart does **not** show a `model` arg — **verify** the exact
  `startThread`/`run` model-selection parameter in the installed package's
  `.d.ts`. Provider is likely meaningless for codex.
- **cursor:** `AgentOptions.model = { id: string; params? }`. The `provider`
  field is meaningless; `model` maps to `model.id`.

Planning must specify how a profile's `provider`/`model` map onto each adapter
(e.g. adapter ignores `provider`, passes `model` verbatim). Flag any profile
that is genuinely incompatible (e.g. a pi-only model used with a cursor agent).

### 4.5 Structured output is already agent-agnostic

`promptForStructured` (structured-output.ts) extracts JSON from the assistant
**text** via `extractJsonFromText` + `parseJsonWithRepair`, with retry. It
depends only on `{ prompt, getLastAssistantText, abort }`. Verify it has **no**
pi-coding-agent coupling. This means structured output works for all three
adapters for free — **do not** use codex/cursor native structured-output; the
text-extraction path is portable and already battle-tested.

### 4.6 Session persistence/resume differs per runtime

- **pi:** `SessionManager.create/open/inMemory`, `session.sessionFile`. engin
  stores the `.jsonl` path for step resume.
- **codex:** threads have a `thread_id`; resume via `resumeThread(threadId)`.
- **cursor:** runs have an `id`; reconnect via `Agent.getRun(id)`.

The neutral contract exposes `sessionFile?: string` (optional). Planning must
specify how each adapter maps its native resume handle onto the engine's
resume semantics (`resumeSessionPath`/`sessionDir` in `AgentSessionOptions`),
and what `sessionFile` reports for non-pi adapters (likely `undefined`, with
the native handle stored elsewhere — or generalize the field to an opaque
`resumeHandle`). This is the main semantic seam — call it out in the plan.

---

## 5. Target SDK research — fit, gaps, and risks (verify each against current docs/packages)

> ⚠️ The SDK surfaces below were reconstructed from docs and the published
> `@openai/codex-sdk` `.d.ts`. They **must** be verified against the actual
> installed package type definitions during scouting. Pin exact versions.

### 5.1 Codex SDK (`@openai/codex-sdk`) — verify all of this

- **Entry:** a `Codex` class; `codex.startThread()`, `codex.resumeThread(threadId)`,
  `thread.run(prompt)`. Verify the exact constructor (API key / options) and
  whether `run()` is request/response or returns an async iterable.
- **Events (from the `.d.ts`):** a streaming event union including
  `thread.started` (carries `thread_id`), `turn.started`, `turn.completed`
  (carries `Usage { input_tokens, cached_input_tokens, output_tokens,
reasoning_output_tokens }`), `turn.failed`, and `item.started` /
  `item.updated` / `item.completed` over a `ThreadItem` union:
  `agent_message` (carries `text`), `reasoning`, `command_execution`
  (`command`, `aggregated_output`, `exit_code`, `status`), `file_change`
  (`changes[]`, `status`), `mcp_tool_call` (`server`, `tool`, `arguments`,
  `result`/`error`, `status`), `web_search`, `todo_list`, `error`.
  **Verify** the exact event type names and how to subscribe (callback vs
  async iterator).
- **Mapping to neutral events:** `turn.started`→`turn_start`,
  `turn.completed`→`turn_end` (map `Usage`→`{input,output}`),
  `command_execution`/`mcp_tool_call` `item.started`→`tool_call_start` /
  `item.completed`→`tool_call_end` (`status==='failed'`→`isError`). `agent_message`
  → `getLastAssistantText()`. There is **no native auto-retry event** — map none.
- **Structured output:** `agent_message.text` can be JSON; the text-extraction
  path handles it (§4.5).
- **Sandbox:** presets `read_only` / `workspace_write` / `full_access` (shown
  for Python; **verify the TS equivalent**). Map `allowedWriteDirs` →
  `workspace_write` writable roots.

### 5.2 Cursor SDK (`@cursor/sdk`) — verify all of this

- **Entry:** `Agent` class; `Agent.create(options)` (async factory);
  `agent.send(prompt)` → `Run`; `Run.stream()` is an `AsyncIterable`;
  `Run.wait()` → `RunResult`; resume via `Agent.getRun(runId, opts)`.
- **`AgentOptions`:** `model?: ModelSelection` (`{ id; params? }`), `apiKey?`,
  `local?: LocalAgentOptions` (`cwd`, `sandboxOptions`, `customTools`, …),
  `cloud?: CloudAgentOptions`. **Verify** the installed `.d.ts` for exact names.
- **Events:** `run.stream()` yields an `SDKMessage` discriminated union on
  `event.type`: `system`, `user`, `assistant` (carries response text via
  `message.content` = `TextBlock[]` + `ToolUseBlock[]`), `tool_call`, `thinking`,
  `status`, `request`, `task`. **Verify** the exact variant names and content
  block shapes (`TextBlock { type:'text'; text }`, `ToolUseBlock { type:'tool_use'; id; name; input }`).
- **Mapping to neutral events:** `assistant`→accumulate text for
  `getLastAssistantText()`; `tool_call` start/end→`tool_call_start`/`tool_call_end`
  (verify whether cursor emits discrete start/end or a single event — if single,
  synthesize the pair). There is **no native turn/usage event** in the documented
  union — `turn_end` token usage may be unavailable (report the gap; the TUI must
  tolerate missing usage). **No native auto-retry event.**
- **Sandbox:** `LocalAgentOptions.sandboxOptions` — **verify** the exact shape and
  whether it can express writable-root allowlists. If cursor's sandbox cannot
  express `allowedWriteDirs`, document the degradation (§4 of §7).

### 5.3 Risks to validate early

1. **Event-fidelity asymmetry.** pi emits rich per-tool-call + retry + usage
   events; codex emits turn+usage+items; cursor emits assistant/tool_call but
   possibly **no usage** and **no discrete turn boundaries**. Confirm each
   adapter can still drive the TUI's agent log acceptably. The neutral contract
   must make usage/turn-end **optional** so cursor doesn't fake data.
2. **Resume handle divergence** (§4.6) — the largest semantic risk. Validate
   that step-level resume (re-running a step on a failure) still works, or
   define a degraded resume path for non-pi agents.
3. **Auth/API-key plumbing.** `AgentSessionOptions.apiKeys` is
   `Record<provider,key>`. codex/cursor take a single `apiKey` / env var. Decide
   how the adapter picks the key (e.g. cursor reads `options.apiKeys['cursor']`
   or `process.env`). Verify how each SDK is configured for credentials.
4. **Abort semantics.** `abort()` must cancel an in-flight prompt. Verify
   `Run.cancel()` (cursor) and the codex cancellation primitive actually stop the
   turn and resolve `prompt()`. The engine races `abort()` on step timeouts
   (structured-output.ts) — a no-op abort would hang the timeout path.

---

## 6. Behavior that MUST be preserved (do not regress)

Scout should confirm each of these works today; the planner must carry them
through the refactor. After the work, **all of these must still hold for pi
profiles**, and as many as possible for codex/cursor:

- **Profile loading & override semantics** — `loadProfilesFromDirs` merges
  global + local dirs (local overrides global on id collision), cached per
  directory. The new `agent:` field must flow through `parseProfile` →
  `AgentProfile` → `spawnAgent` without disturbing the merge/cache.
- **Session resume** — `phase-tasks.ts` stores `session.sessionFile` per step
  and re-spawns with `resumeSessionPath` when re-running a step. Must keep
  working for pi; define the codex/cursor equivalent (§4.6).
- **Structured output** — `promptForStructured` + Zod validation + retry works
  for all adapters via the text-extraction path (§4.5).
- **Write sandbox** — `allowedWriteDirs` confines writes for pi (today); enforce
  via each adapter's native mechanism (§2.5).
- **Status event flow** — turn/tool/token/retry events reach the TUI agent log,
  event log, and web UI via `AgentStatusCallbacks`. The neutral forwarder must
  reproduce today's pi event fidelity for pi profiles exactly.
- **Error classification** — context-overflow vs transient classification
  (`error-classifier.ts`) keeps working via `getLastAssistantMessage()` (§2.4).
- **Abort / cancellation** — `abort()` cancels prompts; step timeouts and
  SIGINT-driven abort still reach a freshly-spawned session (the TOCTOU safety
  in `spawnAgent` must survive the refactor).
- **Backward compatibility** — every existing profile (no `agent:` field) behaves
  identically: same model resolution, same events, same session files.

---

## 7. Things the workflow should explicitly NOT do

- **Do not plan before scouting completes** and the claims in §3–§5 are verified
  against the installed packages and current docs.
- **Do not introduce per-agent branching in engine core.** Core sees only
  `AgentRuntime`; every adapter emits neutral events. A `switch (agentKind)` in
  core is a design failure.
- **Do not break the pi path.** The pi adapter is a pure extraction; if any pi
  behavior changes, that is a regression (unless explicitly noted).
- **Do not use codex/cursor native structured output.** The text-extraction path
  is portable and shared (§4.5).
- **Do not couple the engine to a specific package layout for plugins.** Whether
  the three adapters live in `packages/engine/src/agents/*` or in separate
  workspace packages is a scouting-driven decision — but the engine core must
  not import them directly; they register through the plugin registry.
- **Do not fake event data.** If an adapter can't emit usage/turn-end, leave it
  `undefined` — the TUI must tolerate gaps. Do not synthesize numbers.
- **Do not touch `@earendil-works/pi-tui`** (the TUI's framework) or `packages/tui`.
  That is a separate concern.

---

## 8. Definition of done (for the eventual review phase)

- `rg '@earendil-works/pi-coding-agent' packages/engine/src` returns matches
  **only** inside the pi adapter directory (e.g. `packages/engine/src/agents/pi-coding-agent/**`), nowhere else in `packages/engine/src/core` or `packages/engine/src/pool`.
- `rg 'pi-coding-agent' packages` shows no import outside the pi adapter.
- Engine core imports only the neutral `AgentRuntime`/`AgentPlugin`/
  `AgentRuntimeEvent` types (plus the retained `pi-ai` utilities per §4.3).
- The `pi-coding-agent` plugin reproduces today's behavior exactly: run the
  existing engine test suite green; manually verify a `develop` run with a
  default (no `agent:`) profile is byte-for-byte unchanged (events, session
  files, structured output, resume).
- A profile with `agent: codex` runs a task end-to-end: prompt drives a turn,
  tool calls surface in the TUI agent log, structured-output steps parse, and
  step resume works (or degrades per the documented design).
- A profile with `agent: cursor` runs a task end-to-end with the same checks;
  any unsupported fidelity (e.g. token usage) is `undefined`, not fabricated.
- The `agent:` frontmatter field is documented in `docs/guides/profiles.md`
  (frontmatter table) with the default and the three built-in ids.
- New unit tests cover: the neutral forwarder retargeted onto `AgentRuntimeEvent`;
  `parseProfile` parsing/validating the `agent:` field (default + explicit); the
  plugin registry lookup in `spawnAgent` (default fallback + unknown-agent error).

---

## 9. Suggested scouting targets (to speed up the scout phase)

**Codebase:**

- `packages/engine/src/core/`: `harness-factory.ts`, `agent-lifecycle.ts`,
  `agent-loop.ts`, `write-sandbox.ts`, `error-classifier.ts`,
  `structured-output.ts`, `profile.ts`, `types.ts`, `renderer-registry.ts`.
- `packages/engine/src/core/*.test.ts` — confirm the `{prompt,
getLastAssistantText}` mock pattern and that `harness-factory.test.ts` tests
  the forwarder without pi-dep mocking.
- `packages/engine/src/pool/step-execution.ts`, `phase-tasks.ts`,
  `worktree-lifecycle.ts`, `worktree-fixup.ts`, `title-generator.ts` — every
  `createHarness`/`spawnAgent`/`session.*` call site.
- `packages/engine/src/server/run-executor.ts` — how `profilesDirs` and options
  flow into the run (where a registry would be injected).
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` —
  the consumed `AgentSession` class surface (§3.3).
- `rg '@earendil-works/pi-coding-agent|@earendil-works/pi-ai|pi-agent-core' packages/*/src` — confirm the import boundary (§3.1, §3.2).
- `docs/guides/profiles.md` and `parseProfile` — the frontmatter schema to extend.

**External (verify versions + API against installed packages / current docs):**

- `@openai/codex-sdk` — install/pin, read `dist/*.d.ts`: `Codex` class,
  `startThread`/`resumeThread`/`run`, the streaming event union + `ThreadItem`
  variants, `Usage`, sandbox presets (§5.1).
- `@cursor/sdk` — install/pin, read `.d.ts`: `Agent.create`, `Run.stream`/`wait`/
  `cancel`, the `SDKMessage` union + content blocks, `AgentOptions`/`LocalAgentOptions`/
  `sandboxOptions`, `Agent.getRun` (§5.2).
- Confirm Bun compatibility of both SDKs (this project runs under Bun — check
  `package.json`/`bunfig.toml`/`bun.lock` for the exact runtime version).

**Validate early (de-risk before full implementation):**

- A ~20-line spike per adapter: create a session, `prompt("hello")`, print
  streamed events. Confirm the event taxonomy in §5.1/§5.2 against reality and
  that `abort()`/cancel actually resolves an in-flight turn under Bun.
