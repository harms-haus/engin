# Authoring profiles

An **agent profile** is a Markdown file with YAML frontmatter. The filename (without `.md`)
becomes the profile's `id`. Profiles tell engin which provider/model to use, how the agent
should think, and which tools it may call.

There are no built-in profiles. You define the agents your workflow needs.

## Where profiles live

Profiles are **scoped per workflow**. For a workflow named `apidoc`:

- **Global:** `~/.config/engin/workflows/apidoc/profiles/*.md`
- **Local:** `{cwd}/.engin/workflows/apidoc/profiles/*.md`

On an ID collision within the same workflow, the **local** entry overrides the **global** one.
Use `resolveProfilesDirs(cwd, workflowName)` to get the ordered list of directories to load
from.

## File format

```markdown
---
name: My Agent
agent: pi-coding-agent # optional, default: pi-coding-agent
provider: your-provider
model: your-model
thinkingLevel: medium
excludeTools:
  - write
  - edit
includeTools: []
---

You are a specialised agent. Your instructions go here.
This body text becomes the system prompt.
```

- Everything between the `---` fences is YAML frontmatter.
- The remainder (the Markdown body) becomes the agent's **system prompt**, trimmed.

## Frontmatter fields

| Field           | Required | Default                | Description                                                                      |
| --------------- | -------- | ---------------------- | -------------------------------------------------------------------------------- |
| `provider`      | **Yes**  | —                      | Provider identifier (e.g. `anthropic`, `openai`).                                |
| `model`         | **Yes**  | —                      | Model identifier within the provider.                                            |
| `agent`         | No       | `"pi-coding-agent"`    | Agent runtime plugin id. One of `pi-coding-agent`, `codex`, `cursor`.            |
| `name`          | No       | Filename without `.md` | Human-readable display name.                                                     |
| `thinkingLevel` | No       | `"medium"`             | Model thinking depth. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `excludeTools`  | No       | `[]`                   | Tool names to remove from the default set.                                       |
| `includeTools`  | No       | `[]`                   | If non-empty, only the intersection of these and the default tools is included.  |

`parseProfile` throws if `provider` or `model` is missing, or if `thinkingLevel` is not one of
the allowed values.

## Agent runtime selection

The `agent` field selects which agent runtime backs this profile. The default is
`pi-coding-agent` — existing profiles without this field work unchanged.

| Agent             | Backend                                | Sandbox                              | Session resume               | Event fidelity                                                  |
| ----------------- | -------------------------------------- | ------------------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `pi-coding-agent` | engin's native agent                   | Granular `allowedWriteDirs`          | Persists JSONL session files | Full turn/tool/token/retry events                               |
| `codex`           | OpenAI Codex SDK (`@openai/codex-sdk`) | Workspace-write with additional dirs | Uses thread IDs              | Turn + usage + tool events (no retry)                           |
| `cursor`          | Cursor SDK (`@cursor/sdk`)             | Binary on/off (no granular control)  | Uses run IDs                 | Assistant + tool events (no usage, no discrete turn boundaries) |

**Provider is pi-centric:** for `codex` and `cursor`, the adapter ignores the `provider`
field and uses `model` directly. The provider field is still required for validation but has
no effect on routing.

**Sandbox behavior** varies by adapter:

- `pi-coding-agent` supports granular `allowedWriteDirs` to restrict write access.
- `codex` supports workspace-write with additional directory declarations.
- `cursor` has a binary on/off sandbox — no granular directory control.

**Session resume** differs:

- `pi-coding-agent` persists JSONL session files for full replay.
- `codex` uses thread IDs; resume requires the thread ID to be available.
- `cursor` uses run IDs; resume requires the run ID to be available.
- Non-pi adapters may degrade resume capability compared to the native agent.

**Event fidelity** varies:

- `pi-coding-agent` emits full turn, tool, token, and retry events.
- `codex` emits turn, usage, and tool events (no retry events).
- `cursor` emits assistant and tool events (no usage events, no discrete turn boundaries).
- The TUI tolerates missing fields gracefully.

## Tool filtering — read this carefully

The default toolset is fixed: `['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']`
(`DEFAULT_TOOLS`). The profile's `includeTools` and `excludeTools` filter it as follows:

1. If `includeTools` is **non-empty**, the effective set is the **intersection** of
   `DEFAULT_TOOLS` and `includeTools` (preserving `DEFAULT_TOOLS` order). You cannot use
   `includeTools` to add a tool that is not already in the default set — it is a whitelist that
   can only narrow.
2. If `excludeTools` is **non-empty**, those tools are then removed from the result.

So `includeTools: [read]` yields just `read`; `excludeTools: [write, edit]` yields the default
set minus write/edit. Both can be combined.

In addition, individual **steps** can declare `isReadOnly: true`. Read-only steps automatically
add `write` and `edit` to the profile's `excludeTools` (deduplicated), regardless of what the
profile says. This is how reviewer steps lose their ability to modify files.

## Examples

### Implementer (full default toolset)

```markdown
---
name: Implementer
provider: your-provider
model: your-model
thinkingLevel: medium
---

You are an Implementer agent. Make focused, minimal changes that satisfy the task.
Follow the project's existing conventions. Prefer editing existing files over creating
new ones. When you are done, summarise what you changed and why.
```

### Read-only reviewer

```markdown
---
name: Code Reviewer
provider: your-provider
model: your-model
thinkingLevel: high
excludeTools:
  - write
  - edit
---

You are a Code Reviewer agent. Evaluate the change for correctness, quality, and
adherence to project conventions.

Respond with JSON matching this shape:
{
"approved": boolean,
"feedback": string,
"severity": "critical" | "high" | "medium" | "low"
}
```

Pair this profile with a step that has `schema` and `isReadOnly: true`; the
[RunnerPool](../reference/task-pool.md) will run it via a `reviewRunner` or `singleSession`, parse the JSON,
and use `approved` to decide whether to advance or send feedback back to the implementer.

### Codex agent

```markdown
---
name: Codex Implementer
agent: codex
model: codex-latest
---

You are a Codex agent using the OpenAI Codex SDK.
```

### Cursor agent

```markdown
---
name: Cursor Implementer
agent: cursor
model: claude-sonnet-4
---

You are a Cursor agent using the Cursor SDK.
```

### Structured-output scout

```markdown
---
name: Scout
provider: your-provider
model: your-model
thinkingLevel: medium
---

You are a Scout agent. Read the codebase and identify the work to be done.
Respond with JSON: { "summary": string, "files": string[] }.
```

Use this with [`runSession`](../reference/api.md#runsession) and a matching Zod schema.

## Loading profiles programmatically

| Function                          | Purpose                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadProfiles(dirPath)`           | Load all `.md` files from one directory into a `Map` (cached per directory). Throws if the directory is missing.                                                       |
| `loadProfile(dirPath, profileId)` | Load a single profile by ID.                                                                                                                                           |
| `loadProfileSingle(filePath)`     | Load a profile directly from a file path (bypasses the cache).                                                                                                         |
| `loadProfilesFromDirs(dirs)`      | Merge profiles from multiple directories. Processed in **reverse** so that the **first** entry (local) wins on ID collision. Missing directories are silently skipped. |
| `parseProfile(content, filename)` | Parse a Markdown string into an `AgentProfile`.                                                                                                                        |
| `clearProfileCache()`             | Clear the in-memory profile cache.                                                                                                                                     |

Per-directory results are cached for the process lifetime (a small FIFO-bounded cache). The
merged result from `loadProfilesFromDirs` is **not** cached.

## Where to go next

- [Building a new workflow](building-workflows.md) — use these profiles in a real workflow.
- [Task pool & execution](../reference/task-pool.md) — how `isReadOnly` and `schema` interact
  with session execution, composable runners, and retries.
