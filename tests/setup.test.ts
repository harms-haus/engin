import { mkdir, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Resolve real module objects before mocking so they can be restored in afterAll
const actualFs = Object.assign({}, await import("node:fs/promises"));
const actualConfig = Object.assign({}, await import("../src/core/config.js"));

// Mock ../src/core/config.js so getGlobalConfigDir returns our temp dir
let mockGlobalDir: string;

mock.module("../src/core/config.js", () => ({
    getGlobalConfigDir: () => mockGlobalDir,
    ensureDir: async (dirPath: string) => {
        const { mkdir: mkdirFn } = await import("node:fs/promises");
        await mkdirFn(dirPath, { recursive: true });
    },
}));

// Flag to control readdir mock for ENOENT test
let mockReaddirENOENT = false;
let enoentDirs: string[] = [];

mock.module("node:fs/promises", () => ({
    ...actualFs,
    readdir: async (...args: [path: string | URL | FileHandle, options?: unknown]) => {
        const pathStr =
            typeof args[0] === "string"
                ? args[0]
                : args[0] instanceof URL
                  ? args[0].pathname
                  : "";
        if (mockReaddirENOENT && enoentDirs.includes(pathStr)) {
            const err = new Error("ENOENT: no such file or directory") as Error & { code?: string };
            err.code = "ENOENT";
            throw err;
        }
        // Use the sync API from node:fs (unmocked) to avoid infinite recursion
        return readdirSync(
            pathStr,
            typeof args[1] === "object" ? (args[1] as object) : undefined,
        );
    },
}));

import { initDefaultConfig } from "../src/setup.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realDefaultsDir = join(projectRoot, "defaults");

// Restore original modules so mocks don't leak to other test files in the same process
afterAll(() => {
    mock.module("../src/core/config.js", () => actualConfig);
    mock.module("node:fs/promises", () => actualFs);
});

describe("initDefaultConfig", () => {
    let tempBase: string;

    beforeEach(async () => {
        mockReaddirENOENT = false;
        enoentDirs = [];

        tempBase = join(tmpdir(), `wh-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tempBase, { recursive: true });
        mockGlobalDir = join(tempBase, "global-config");
        await mkdir(mockGlobalDir, { recursive: true });
    });

    afterEach(async () => {
        mockReaddirENOENT = false;
        enoentDirs = [];
        await rm(tempBase, { recursive: true, force: true });
    });

    it("copies default profiles and workflows to global config dir", async () => {
        const result = await initDefaultConfig();

        expect(result.installed.length).toBeGreaterThan(0);
        expect(result.skipped).toEqual([]);

        // Verify profile files exist in target
        const profilesDir = join(mockGlobalDir, "profiles");
        const profileFiles = readdirSync(profilesDir);
        expect(profileFiles.length).toBeGreaterThan(0);

        // Verify workflow files exist in target
        const workflowsDir = join(mockGlobalDir, "workflows");
        const workflowFiles = readdirSync(workflowsDir);
        expect(workflowFiles).toContain("develop.js");

        // Verify content matches source
        for (const relPath of result.installed) {
            const sourceContent = await readFile(join(realDefaultsDir, relPath), "utf-8");
            const targetContent = await readFile(join(mockGlobalDir, relPath), "utf-8");
            expect(targetContent).toBe(sourceContent);
        }
    });

    it("skips files that already exist", async () => {
        const first = await initDefaultConfig();
        expect(first.installed.length).toBeGreaterThan(0);
        expect(first.skipped).toEqual([]);

        const second = await initDefaultConfig();
        expect(second.installed).toEqual([]);
        expect(second.skipped.length).toBeGreaterThan(0);
        expect(second.skipped.sort()).toEqual(first.installed.sort());
    });

    it("overwrites existing files when force is true", async () => {
        const first = await initDefaultConfig();
        expect(first.installed.length).toBeGreaterThan(0);

        const forced = await initDefaultConfig({ force: true });
        expect(forced.installed.length).toBeGreaterThan(0);
        expect(forced.skipped).toEqual([]);
        expect(forced.installed.sort()).toEqual(first.installed.sort());
    });

    it("handles nonexistent defaults dir with warning and empty arrays", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

        enoentDirs = [join(realDefaultsDir, "profiles"), join(realDefaultsDir, "workflows")];
        mockReaddirENOENT = true;

        const result = await initDefaultConfig();

        expect(result.installed).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(errSpy).toHaveBeenCalled();
        const stderrOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
        expect(stderrOutput).toContain("warning: defaults directory not found");

        errSpy.mockRestore();
    });
});
