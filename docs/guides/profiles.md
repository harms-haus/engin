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
| `name`          | No       | Filename without `.md` | Human-readable display name.                                                     |
| `thinkingLevel` | No       | `"medium"`             | Model thinking depth. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `excludeTools`  | No       | `[]`                   | Tool names to remove from the default set.                                       |
| `includeTools`  | No       | `[]`                   | If non-empty, only the intersection of these and the default tools is included.  |

`parseProfile` throws if `provider` or `model` is missing, or if `thinkingLevel` is not one of
the allowed values.

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
[LanePool](../reference/task-pool.md) will run it, parse the JSON, and use `approved` to decide
whether to advance or send feedback back to the implementer.

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

Use this with [`runStepTask`](../reference/api.md#runsteptask) and a matching Zod schema.

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
  with step execution and retries.
