// ─── Tool Registry ──────────────────────────────────────────────────────────
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, ExecutionEnv } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Unwrap a {@link Result}, throwing the error on failure. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
    if (result.ok) return result.value;
    throw result.error;
}

function textContent(text: string) {
    return { type: "text" as const, text };
}

// ─── ToolRegistryEntry ──────────────────────────────────────────────────────

export interface ToolRegistryEntry {
    name: string;
    tool: AgentTool;
}

// ─── ToolRegistry ───────────────────────────────────────────────────────────

/**
 * A name-indexed collection of {@link AgentTool} instances.
 *
 * Supports registration, lookup, and filtered resolution based on
 * include/exclude lists.
 */
export class ToolRegistry {
    private readonly entries = new Map<string, AgentTool>();

    constructor(entries: ToolRegistryEntry[]) {
        for (const entry of entries) {
            this.entries.set(entry.name, entry.tool);
        }
    }

    /** Register (or replace) a tool entry. */
    register(entry: ToolRegistryEntry): void {
        this.entries.set(entry.name, entry.tool);
    }

    /** Look up a tool by name. */
    get(name: string): AgentTool | undefined {
        return this.entries.get(name);
    }

    /** Return every registered tool. */
    getAll(): AgentTool[] {
        return [...this.entries.values()];
    }

    /**
     * Resolve a filtered list of tools.
     *
     * 1. Start with all registered tools.
     * 2. If `includeTools` is non-empty, keep only the listed names.
     * 3. Remove any tools listed in `excludeTools`.
     */
    resolveTools(includeTools: string[], excludeTools: string[]): AgentTool[] {
        let tools = this.getAll();

        if (includeTools.length > 0) {
            const includeSet = new Set(includeTools);
            tools = tools.filter((t) => includeSet.has(t.name));
        }

        if (excludeTools.length > 0) {
            const excludeSet = new Set(excludeTools);
            tools = tools.filter((t) => !excludeSet.has(t.name));
        }

        return tools;
    }
}

// ─── Tool Param Types ───────────────────────────────────────────────────────

interface ReadParams {
    path: string;
    offset?: number;
    limit?: number;
}

interface BashParams {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface WriteParams {
    path: string;
    content: string;
}

interface EditParams {
    path: string;
    oldText: string;
    newText: string;
}

interface GrepParams {
    pattern: string;
    path?: string;
    glob?: string;
}

interface FindParams {
    pattern: string;
    path?: string;
}

interface LsParams {
    path?: string;
}

// ─── Default Tool Factory ───────────────────────────────────────────────────

/**
 * Create a {@link ToolRegistry} pre-loaded with the seven canonical tools:
 * `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`.
 *
 * Each tool wraps the corresponding {@link ExecutionEnv} method and uses
 * TypeBox schemas for parameter validation.
 */
export function createDefaultToolRegistry(env: ExecutionEnv): ToolRegistry {
    const tools: ToolRegistryEntry[] = [
        // ── read ──────────────────────────────────────────────────────────
        {
            name: "read",
            tool: {
                name: "read",
                label: "Read",
                description:
                    "Read the contents of a file. Returns the full text or a line range.",
                parameters: Type.Object({
                    path: Type.String({ description: "Path to the file to read" }),
                    offset: Type.Optional(
                        Type.Number({
                            description: "Line number to start reading from (1-indexed)",
                        }),
                    ),
                    limit: Type.Optional(
                        Type.Number({
                            description: "Maximum number of lines to read",
                        }),
                    ),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as ReadParams;
                    if (p.offset !== undefined || p.limit !== undefined) {
                        const result = await env.readTextLines(p.path, {
                            maxLines: p.offset !== undefined ? undefined : p.limit,
                        });
                        const allLines = unwrap(result);
                        const start = p.offset ?? 0;
                        const lines = allLines.slice(start, start + (p.limit ?? allLines.length));
                        return {
                            content: [textContent(lines.join("\n"))],
                            details: lines,
                        };
                    }
                    const result = await env.readTextFile(p.path);
                    const text = unwrap(result);
                    return {
                        content: [textContent(text)],
                        details: text,
                    };
                },
            },
        },

        // ── bash ──────────────────────────────────────────────────────────
        {
            name: "bash",
            tool: {
                name: "bash",
                label: "Bash",
                description: "Execute a shell command.",
                parameters: Type.Object({
                    command: Type.String({ description: "Command to execute" }),
                    cwd: Type.Optional(
                        Type.String({ description: "Working directory for the command" }),
                    ),
                    timeout: Type.Optional(
                        Type.Number({ description: "Timeout in seconds" }),
                    ),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as BashParams;
                    const result = await env.exec(p.command, {
                        cwd: p.cwd,
                        timeout: p.timeout,
                    });
                    const { stdout, stderr, exitCode } = unwrap(result);
                    const output = [stdout, stderr].filter(Boolean).join("\n");
                    return {
                        content: [textContent(output || "(no output)")],
                        details: { stdout, stderr, exitCode },
                    };
                },
            },
        },

        // ── write ─────────────────────────────────────────────────────────
        {
            name: "write",
            tool: {
                name: "write",
                label: "Write",
                description:
                    "Write content to a file, creating parent directories when necessary.",
                parameters: Type.Object({
                    path: Type.String({ description: "Path to the file to write" }),
                    content: Type.String({ description: "Content to write" }),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as WriteParams;
                    unwrap(await env.writeFile(p.path, p.content));
                    return {
                        content: [textContent(`Wrote ${p.content.length} chars to ${p.path}`)],
                        details: { path: p.path, bytes: p.content.length },
                    };
                },
            },
        },

        // ── edit ──────────────────────────────────────────────────────────
        {
            name: "edit",
            tool: {
                name: "edit",
                label: "Edit",
                description: "Edit a file by replacing an exact text match.",
                parameters: Type.Object({
                    path: Type.String({ description: "Path to the file to edit" }),
                    oldText: Type.String({
                        description: "Exact text to find and replace",
                    }),
                    newText: Type.String({ description: "Replacement text" }),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as EditParams;
                    const original = unwrap(await env.readTextFile(p.path));
                    if (!original.includes(p.oldText)) {
                        throw new Error(
                            `oldText not found in ${p.path}`,
                        );
                    }
                    const updated = original.replace(p.oldText, p.newText);
                    unwrap(await env.writeFile(p.path, updated));
                    return {
                        content: [textContent(`Edited ${p.path}`)],
                        details: { path: p.path },
                    };
                },
            },
        },

        // ── grep ──────────────────────────────────────────────────────────
        {
            name: "grep",
            tool: {
                name: "grep",
                label: "Grep",
                description: "Search file contents for a pattern.",
                parameters: Type.Object({
                    pattern: Type.String({ description: "Search pattern (regex)" }),
                    path: Type.Optional(
                        Type.String({ description: "Directory or file to search" }),
                    ),
                    glob: Type.Optional(
                        Type.String({ description: "File glob filter, e.g. '*.ts'" }),
                    ),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as GrepParams;
                    const args = ["-n", "--color=never"];
                    if (p.glob) args.push("--include", p.glob);
                    args.push("--", p.pattern, p.path ?? ".");
                    const result = await env.exec(`grep ${args.map(shellEscape).join(" ")}`);
                    const { stdout, exitCode } = unwrap(result);
                    // exit code 1 = no matches (not an error)
                    if (exitCode === 1) {
                        return {
                            content: [textContent("(no matches)")],
                            details: [],
                        };
                    }
                    return {
                        content: [textContent(stdout || "(no matches)")],
                        details: stdout.split("\n").filter(Boolean),
                    };
                },
            },
        },

        // ── find ──────────────────────────────────────────────────────────
        {
            name: "find",
            tool: {
                name: "find",
                label: "Find",
                description: "Search for files by glob pattern.",
                parameters: Type.Object({
                    pattern: Type.String({
                        description: "Glob pattern, e.g. '**/*.ts'",
                    }),
                    path: Type.Optional(
                        Type.String({ description: "Directory to search in" }),
                    ),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as FindParams;
                    const searchDir = p.path ?? ".";
                    // Strip leading **/ so -name can handle the rest (e.g. **/*.ts → *.ts)
                    const namePattern = p.pattern.replace(/^\*\*\//, "");
                    const result = await env.exec(
                        `find ${shellEscape(searchDir)} -type f -name ${shellEscape(namePattern)}`,
                    );
                    const { stdout, exitCode } = unwrap(result);
                    if (exitCode !== 0 || !stdout.trim()) {
                        return {
                            content: [textContent("(no results)")],
                            details: [],
                        };
                    }
                    return {
                        content: [textContent(stdout.trim())],
                        details: stdout.split("\n").filter(Boolean),
                    };
                },
            },
        },

        // ── ls ────────────────────────────────────────────────────────────
        {
            name: "ls",
            tool: {
                name: "ls",
                label: "List",
                description: "List directory contents.",
                parameters: Type.Object({
                    path: Type.Optional(
                        Type.String({ description: "Directory path" }),
                    ),
                }),
                execute: async (_toolCallId, params) => {
                    const p = params as LsParams;
                    const result = await env.listDir(p.path ?? ".");
                    const entries = unwrap(result);
                    const lines = entries.map(
                        (e) => `${e.kind === "directory" ? "d" : "-"} ${e.name}`,
                    );
                    return {
                        content: [textContent(lines.join("\n") || "(empty)")],
                        details: entries.map((e) => ({
                            name: e.name,
                            kind: e.kind,
                            size: e.size,
                        })),
                    };
                },
            },
        },
    ];

    return new ToolRegistry(tools);
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Minimal shell-escape for arguments embedded in command strings. */
function shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
