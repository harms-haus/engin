import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry, createDefaultToolRegistry } from "../../src/core/tool-registry.ts";
import type { ExecutionEnv, AgentTool } from "../../src/core/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok<T>(value: T) {
    return { ok: true as const, value };
}


function makeTool(name: string): AgentTool {
    return {
        name,
        label: name,
        description: `Tool ${name}`,
        parameters: { type: "object", properties: {} },
        execute: async () => ({
            content: [{ type: "text", text: `ran ${name}` }],
            details: null,
        }),
    };
}

function mockEnv(): ExecutionEnv {
    return {
        cwd: "/tmp",
        absolutePath: vi.fn(async (p: string) => ok(p)),
        joinPath: vi.fn(async (parts: string[]) => ok(parts.join("/"))),
        readTextFile: vi.fn(async () => ok("file contents")),
        readTextLines: vi.fn(async () => ok(["line 1", "line 2"])),
        readBinaryFile: vi.fn(async () => ok(new Uint8Array())),
        writeFile: vi.fn(async () => ok(undefined)),
        appendFile: vi.fn(async () => ok(undefined)),
        fileInfo: vi.fn(async () =>
            ok({ name: "test", path: "/tmp/test", kind: "file" as const, size: 100, mtimeMs: 0 }),
        ),
        listDir: vi.fn(async () =>
            ok([
                { name: "a.txt", path: "/tmp/a.txt", kind: "file" as const, size: 10, mtimeMs: 0 },
                { name: "sub", path: "/tmp/sub", kind: "directory" as const, size: 0, mtimeMs: 0 },
            ]),
        ),
        canonicalPath: vi.fn(async (p: string) => ok(p)),
        exists: vi.fn(async () => ok(true)),
        createDir: vi.fn(async () => ok(undefined)),
        remove: vi.fn(async () => ok(undefined)),
        createTempDir: vi.fn(async () => ok("/tmp/tmp-xyz")),
        createTempFile: vi.fn(async () => ok("/tmp/tmp-xyz.txt")),
        cleanup: vi.fn(async () => {}),
        exec: vi.fn(async () => ok({ stdout: "output", stderr: "", exitCode: 0 })),
    };
}

// ─── ToolRegistry ───────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        const entries = [
            { name: "alpha", tool: makeTool("alpha") },
            { name: "beta", tool: makeTool("beta") },
            { name: "gamma", tool: makeTool("gamma") },
        ];
        registry = new ToolRegistry(entries);
    });

    it("retrieves a registered tool by name", () => {
        const tool = registry.get("alpha");
        expect(tool).toBeDefined();
        expect(tool!.name).toBe("alpha");
    });

    it("returns undefined for an unregistered name", () => {
        expect(registry.get("nope")).toBeUndefined();
    });

    it("getAll returns every registered tool", () => {
        const all = registry.getAll();
        expect(all).toHaveLength(3);
        expect(all.map((t) => t.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    });

    it("register adds a new tool", () => {
        registry.register({ name: "delta", tool: makeTool("delta") });
        expect(registry.get("delta")).toBeDefined();
        expect(registry.getAll()).toHaveLength(4);
    });

    it("register replaces an existing tool with the same name", () => {
        const replacement = makeTool("alpha");
        replacement.description = "replaced";
        registry.register({ name: "alpha", tool: replacement });
        expect(registry.get("alpha")!.description).toBe("replaced");
        expect(registry.getAll()).toHaveLength(3);
    });
});

// ─── resolveTools ───────────────────────────────────────────────────────────

describe("resolveTools", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        const entries = [
            { name: "read", tool: makeTool("read") },
            { name: "write", tool: makeTool("write") },
            { name: "edit", tool: makeTool("edit") },
            { name: "bash", tool: makeTool("bash") },
        ];
        registry = new ToolRegistry(entries);
    });

    it("returns all tools when both lists are empty", () => {
        const result = registry.resolveTools([], []);
        expect(result).toHaveLength(4);
    });

    it("filters by includeTools", () => {
        const result = registry.resolveTools(["read", "write"], []);
        expect(result).toHaveLength(2);
        expect(result.map((t) => t.name)).toEqual(["read", "write"]);
    });

    it("filters by excludeTools", () => {
        const result = registry.resolveTools([], ["bash"]);
        expect(result).toHaveLength(3);
        expect(result.map((t) => t.name)).not.toContain("bash");
    });

    it("applies include then exclude", () => {
        const result = registry.resolveTools(["read", "write", "edit"], ["write"]);
        expect(result).toHaveLength(2);
        expect(result.map((t) => t.name)).toEqual(["read", "edit"]);
    });

    it("returns empty when includeTools references nothing registered", () => {
        const result = registry.resolveTools(["nonexistent"], []);
        expect(result).toHaveLength(0);
    });
});

// ─── createDefaultToolRegistry ──────────────────────────────────────────────

describe("createDefaultToolRegistry", () => {
    it("creates a registry with all 7 canonical tools", () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const all = registry.getAll();
        expect(all).toHaveLength(7);

        const names = all.map((t) => t.name).sort();
        expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    });

    it("each tool has name, label, description, and parameters", () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        for (const tool of registry.getAll()) {
            expect(tool.name).toBeTruthy();
            expect(tool.label).toBeTruthy();
            expect(tool.description).toBeTruthy();
            expect(tool.parameters).toBeDefined();
            expect(typeof tool.execute).toBe("function");
        }
    });

    it("read tool delegates to env.readTextFile", async () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const readTool = registry.get("read")!;

        const result = await readTool.execute("call-1", { path: "/tmp/hello.txt" });
        expect(env.readTextFile).toHaveBeenCalledWith("/tmp/hello.txt");
        expect(result.content[0]).toEqual({ type: "text", text: "file contents" });
    });

    it("read tool delegates to env.readTextLines when offset/limit given", async () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const readTool = registry.get("read")!;

        const result = await readTool.execute("call-2", { path: "/tmp/hello.txt", limit: 10 });
        expect(env.readTextLines).toHaveBeenCalledWith("/tmp/hello.txt", { maxLines: 10 });
        expect(result.content[0].text).toBe("line 1\nline 2");
    });

    it("bash tool delegates to env.exec", async () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const bashTool = registry.get("bash")!;

        const result = await bashTool.execute("call-3", { command: "echo hi" });
        expect(env.exec).toHaveBeenCalledWith("echo hi", { cwd: undefined, timeout: undefined });
        expect(result.details).toEqual({ stdout: "output", stderr: "", exitCode: 0 });
    });

    it("write tool delegates to env.writeFile", async () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const writeTool = registry.get("write")!;

        const result = await writeTool.execute("call-4", { path: "/tmp/out.txt", content: "hello" });
        expect(env.writeFile).toHaveBeenCalledWith("/tmp/out.txt", "hello");
        expect(result.content[0].text).toContain("Wrote");
    });

    it("edit tool reads, replaces, and writes back", async () => {
        const env = mockEnv();
        (env.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok("foo bar baz"),
        );
        const registry = createDefaultToolRegistry(env);
        const editTool = registry.get("edit")!;

        await editTool.execute("call-5", {
            path: "/tmp/edit.txt",
            oldText: "bar",
            newText: "qux",
        });
        expect(env.readTextFile).toHaveBeenCalled();
        expect(env.writeFile).toHaveBeenCalledWith("/tmp/edit.txt", "foo qux baz");
    });

    it("edit tool throws when oldText is not found", async () => {
        const env = mockEnv();
        (env.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok("original"),
        );
        const registry = createDefaultToolRegistry(env);
        const editTool = registry.get("edit")!;

        await expect(
            editTool.execute("call-6", {
                path: "/tmp/edit.txt",
                oldText: "nope",
                newText: "replacement",
            }),
        ).rejects.toThrow("oldText not found");
    });

    it("ls tool delegates to env.listDir", async () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);
        const lsTool = registry.get("ls")!;

        const result = await lsTool.execute("call-7", {});
        expect(env.listDir).toHaveBeenCalledWith(".");
        expect(result.details).toHaveLength(2);
    });

    it("resolveTools works on the default registry", () => {
        const env = mockEnv();
        const registry = createDefaultToolRegistry(env);

        const subset = registry.resolveTools(["read", "bash"], []);
        expect(subset).toHaveLength(2);
        expect(subset.map((t) => t.name).sort()).toEqual(["bash", "read"]);
    });

    it("find tool delegates to env.exec with -name flag", async () => {
        const env = mockEnv();
        (env.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok({ stdout: "/tmp/src/a.ts\n/tmp/src/b.ts", stderr: "", exitCode: 0 }),
        );
        const registry = createDefaultToolRegistry(env);
        const findTool = registry.get("find")!;

        const result = await findTool.execute("call-8", {
            pattern: "**/*.ts",
            path: "/tmp/src",
        });
        expect(env.exec).toHaveBeenCalledWith(
            expect.stringContaining("-name '*.ts'"),
        );
        expect(result.details).toEqual(["/tmp/src/a.ts", "/tmp/src/b.ts"]);
    });

    it("find tool returns no results on empty output", async () => {
        const env = mockEnv();
        (env.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok({ stdout: "", stderr: "", exitCode: 0 }),
        );
        const registry = createDefaultToolRegistry(env);
        const findTool = registry.get("find")!;

        const result = await findTool.execute("call-9", {
            pattern: "**/*.ts",
        });
        expect(result.content[0].text).toBe("(no results)");
        expect(result.details).toEqual([]);
    });

    it("find tool returns no results on non-zero exit code", async () => {
        const env = mockEnv();
        (env.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok({ stdout: "", stderr: "", exitCode: 1 }),
        );
        const registry = createDefaultToolRegistry(env);
        const findTool = registry.get("find")!;

        const result = await findTool.execute("call-10", {
            pattern: "**/*.ts",
        });
        expect(result.content[0].text).toBe("(no results)");
        expect(result.details).toEqual([]);
    });

    it("grep tool delegates to env.exec with correct args", async () => {
        const env = mockEnv();
        (env.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok({ stdout: "src/app.ts:42:const x = 1", stderr: "", exitCode: 0 }),
        );
        const registry = createDefaultToolRegistry(env);
        const grepTool = registry.get("grep")!;

        const result = await grepTool.execute("call-11", {
            pattern: "const x",
            path: "/tmp/src",
            glob: "*.ts",
        });
        expect(env.exec).toHaveBeenCalledWith(
            expect.stringContaining("'const x'"),
        );
        expect(result.details).toEqual(["src/app.ts:42:const x = 1"]);
    });

    it("grep tool returns no matches on exit code 1", async () => {
        const env = mockEnv();
        (env.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
            ok({ stdout: "", stderr: "", exitCode: 1 }),
        );
        const registry = createDefaultToolRegistry(env);
        const grepTool = registry.get("grep")!;

        const result = await grepTool.execute("call-12", {
            pattern: "nope",
        });
        expect(result.content[0].text).toBe("(no matches)");
        expect(result.details).toEqual([]);
    });
});
