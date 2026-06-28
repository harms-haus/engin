# engin documentation

**engin** — short for "**Engin**eered **In**ference" — is a script-based workflow engine for
AI-driven software development. It is built on top of
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
and provides a phase-based approach to breaking down, planning, implementing, and reviewing
code changes with multiple cooperating agents.

This directory is the documentation library. It is organised by **domain** so you can read
just the part you need.

## New here?

Read in this order:

1. [**Concepts → Overview**](concepts/overview.md) — the mental model (workflow → phases → tasks → sessions).
2. [**Guides → Getting started**](guides/getting-started.md) — install and run your first workflow.
3. [**Guides → Building a new workflow**](guides/building-workflows.md) — the main authoring guide.
4. [**Guides → Profiles**](guides/profiles.md) — how agent profiles work.

## The full library

### Concepts

| Document                                 | What it covers                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [Overview](concepts/overview.md)         | What engin is, the rigid execution hierarchy, and the system's key properties.                                                    |
| [Architecture](concepts/architecture.md) | The client/server process model, the 5-package workspace layout, and how status flows from the server to the TUI and web clients. |

### Guides

| Document                                                | What it covers                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Getting started](guides/getting-started.md)            | Prerequisites, installation, first-time setup, and a first run.                  |
| [Building a new workflow](guides/building-workflows.md) | The primary authoring guide. Walks through a complete worked example end to end. |
| [Authoring profiles](guides/profiles.md)                | The profile file format, frontmatter fields, tool filtering, and examples.       |

### Reference

| Document                                         | What it covers                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CLI reference](reference/cli.md)                | `run`, `resume`, `server up/down/status`, every flag, default, exit code, and the detach/kill semantics.                                                                                                                                                                                                                                            |
| [Server reference](reference/server.md)          | The daemon, `RunManager`, the multi-run WebSocket protocol, auth attach-points, and the `--lan` guard.                                                                                                                                                                                                                                              |
| [Worktrees reference](reference/worktrees.md)    | The per-task worktree system, `.worktreecopy`, branch naming, merge serialization, and the final-merge UX.                                                                                                                                                                                                                                          |
| [Configuration](reference/configuration.md)      | Config directory resolution, `.env` loading, API-key resolution precedence, and resuming runs.                                                                                                                                                                                                                                                      |
| [Programmatic API](reference/api.md)             | Every exported function and class with signatures and semantics.                                                                                                                                                                                                                                                                                    |
| [Types reference](reference/types.md)            | Every exported type and interface.                                                                                                                                                                                                                                                                                                                  |
| [Event store & status](reference/event-store.md) | The event-sourced status model: `EventStore`, the `evolve` reducer, the projection, the `log` event, and clients.                                                                                                                                                                                                                                   |
| [Task pool & execution](reference/task-pool.md)  | `SessionScheduler`, `TaskGraph`, `SessionGate`, the `runSession` session primitive, composable runners (`singleSession`, `linearRunner`, `reviewRunner`, …), and the prompt builder.                                                                                                                                                                |
| [Hooks](reference/hooks.md)                      | The hook system: the `WorkflowHooks` catalog, composition rules (`observe`/`pipeline`/`first-wins`/`all-run`), `HookRegistry`, `composeHooks`, default implementations, wiring, and the `fixLoop`/final-review boundary. **Note:** `beforeStepPrompt` was renamed to `beforeSessionPrompt` in the session-first redesign (the old name is deleted). |
| [TUI dashboard](reference/tui.md)                | The terminal client: `WorkflowTUI`, widgets, keyboard shortcuts, the detach/kill prompt, and theme.                                                                                                                                                                                                                                                 |
| [Web client](reference/web.md)                   | The React client, the shared `EngineClient`, the zustand store, and the runs frame.                                                                                                                                                                                                                                                                 |

### Development

| Document                                   | What it covers                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Contributing & internals](development.md) | Build/test/lint scripts, formatting, pre-commit hooks, CI, and the project layout. |

## A note on accuracy

Every API table in this library was regenerated against the current source in the
`packages/` workspace. If a claim here ever disagrees with the code, the code wins —
please open an issue.
