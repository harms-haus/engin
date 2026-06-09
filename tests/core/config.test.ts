import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    getGlobalConfigDir,
    getLocalConfigDir,
    resolveProfilesDirs,
    resolveWorkflowsDirs,
    getDefaultWorkDir,
    ensureDir,
} from "../../src/core/config.js";

// ─── Temp directory helper ──────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
    tempDir = join(tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
});

// ─── getGlobalConfigDir ────────────────────────────────────────────────────

describe("getGlobalConfigDir", () => {
    let savedXdg: string | undefined;

    beforeEach(() => {
        savedXdg = process.env.XDG_CONFIG_HOME;
    });

    afterEach(() => {
        if (savedXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = savedXdg;
        }
    });

    it("returns $XDG_CONFIG_HOME/workflow-harness when XDG_CONFIG_HOME is set", () => {
        process.env.XDG_CONFIG_HOME = "/custom/xdg";
        expect(getGlobalConfigDir()).toBe("/custom/xdg/workflow-harness");
    });

    it("falls back to ~/.config/workflow-harness when XDG_CONFIG_HOME is not set", () => {
        delete process.env.XDG_CONFIG_HOME;
        const result = getGlobalConfigDir();
        expect(result).toMatch(/\/\.config\/workflow-harness$/);
        expect(result).toContain(".config");
    });

    it("falls back to ~/.config/workflow-harness when XDG_CONFIG_HOME is empty string", () => {
        process.env.XDG_CONFIG_HOME = "";
        const result = getGlobalConfigDir();
        expect(result).toMatch(/\/\.config\/workflow-harness$/);
    });
});

// ─── getLocalConfigDir ─────────────────────────────────────────────────────

describe("getLocalConfigDir", () => {
    it("returns cwd/.workflow-harness", () => {
        expect(getLocalConfigDir("/project")).toBe("/project/.workflow-harness");
    });

    it("handles nested paths", () => {
        expect(getLocalConfigDir("/home/user/projects/my-app")).toBe(
            "/home/user/projects/my-app/.workflow-harness",
        );
    });
});

// ─── resolveProfilesDirs ───────────────────────────────────────────────────

describe("resolveProfilesDirs", () => {
    it("returns local-before-global order", () => {
        const dirs = resolveProfilesDirs("/project");
        expect(dirs).toHaveLength(2);
        expect(dirs[0]).toBe("/project/.workflow-harness/profiles");
        expect(dirs[1]).toMatch(/\/workflow-harness\/profiles$/);
    });

    it("local dir is first (override priority)", () => {
        const dirs = resolveProfilesDirs("/project");
        expect(dirs[0]).toContain("/project/.workflow-harness");
    });
});

// ─── resolveWorkflowsDirs ──────────────────────────────────────────────────

describe("resolveWorkflowsDirs", () => {
    it("returns local-before-global order", () => {
        const dirs = resolveWorkflowsDirs("/project");
        expect(dirs).toHaveLength(2);
        expect(dirs[0]).toBe("/project/.workflow-harness/workflows");
        expect(dirs[1]).toMatch(/\/workflow-harness\/workflows$/);
    });

    it("local dir is first (override priority)", () => {
        const dirs = resolveWorkflowsDirs("/project");
        expect(dirs[0]).toContain("/project/.workflow-harness");
    });
});

// ─── getDefaultWorkDir ─────────────────────────────────────────────────────

describe("getDefaultWorkDir", () => {
    it("returns correct path under local config dir", () => {
        expect(getDefaultWorkDir("/project", "my-workflow")).toBe(
            "/project/.workflow-harness/work/my-workflow",
        );
    });

    it("handles workflow names with hyphens", () => {
        expect(getDefaultWorkDir("/app", "deploy-prod")).toBe(
            "/app/.workflow-harness/work/deploy-prod",
        );
    });
});

// ─── ensureDir ─────────────────────────────────────────────────────────────

describe("ensureDir", () => {
    it("creates a directory that does not exist", async () => {
        const newDir = join(tempDir, "nested", "sub", "dir");
        await ensureDir(newDir);

        const s = await stat(newDir);
        expect(s.isDirectory()).toBe(true);
    });

    it("succeeds when directory already exists", async () => {
        const existingDir = join(tempDir, "already-here");
        await mkdir(existingDir, { recursive: true });

        // Should not throw
        await ensureDir(existingDir);

        const s = await stat(existingDir);
        expect(s.isDirectory()).toBe(true);
    });
});
