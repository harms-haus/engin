import { rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";

// Resolve real module objects before mocking so they can be restored in afterAll
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

import { initDefaultConfig } from "../src/setup.ts";

// Restore original modules so mocks don't leak to other test files in the same process
afterAll(() => {
    mock.module("../src/core/config.js", () => actualConfig);
});

describe("initDefaultConfig", () => {
    let tempBase: string;

    beforeEach(async () => {
        tempBase = join(tmpdir(), `wh-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tempBase, { recursive: true });
        mockGlobalDir = join(tempBase, "global-config");
        await mkdir(mockGlobalDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tempBase, { recursive: true, force: true });
    });

    it("creates profiles/ and workflows/ directories in global config dir", async () => {
        await initDefaultConfig();

        const profilesStat = await stat(join(mockGlobalDir, "profiles"));
        expect(profilesStat.isDirectory()).toBe(true);

        const workflowsStat = await stat(join(mockGlobalDir, "workflows"));
        expect(workflowsStat.isDirectory()).toBe(true);
    });

    it("returns createdDirs with profiles and workflows", async () => {
        const result = await initDefaultConfig();

        expect(result).toEqual({ createdDirs: ["profiles", "workflows"] });
    });

    it("is idempotent when directories already exist", async () => {
        await initDefaultConfig();

        // Second call should not throw
        const result = await initDefaultConfig();
        expect(result).toEqual({ createdDirs: ["profiles", "workflows"] });

        // Directories still exist
        const profilesStat = await stat(join(mockGlobalDir, "profiles"));
        expect(profilesStat.isDirectory()).toBe(true);
        const workflowsStat = await stat(join(mockGlobalDir, "workflows"));
        expect(workflowsStat.isDirectory()).toBe(true);
    });

    it("works when global config dir does not exist yet", async () => {
        // Point mockGlobalDir to a path whose parent exists but it does not
        mockGlobalDir = join(tempBase, "brand-new-config");

        const result = await initDefaultConfig();
        expect(result).toEqual({ createdDirs: ["profiles", "workflows"] });

        // Both subdirectories were created recursively
        const profilesStat = await stat(join(mockGlobalDir, "profiles"));
        expect(profilesStat.isDirectory()).toBe(true);
        const workflowsStat = await stat(join(mockGlobalDir, "workflows"));
        expect(workflowsStat.isDirectory()).toBe(true);
    });
});
