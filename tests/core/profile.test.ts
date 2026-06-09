import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProfile, loadProfiles, loadProfile, loadProfilesFromDirs, clearProfileCache } from "../../src/core/profile.js";

// ─── Helper to create a temp directory for each test ────────────────────────
let tempDir: string;

beforeEach(async () => {
    tempDir = join(tmpdir(), `profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
    clearProfileCache();
    await rm(tempDir, { recursive: true, force: true });
});

// ─── parseProfile ───────────────────────────────────────────────────────────

describe("parseProfile", () => {
    it("parses a profile with full frontmatter", () => {
        const content = [
            "---",
            "name: Scout Agent",
            "provider: openai",
            "model: gpt-4o",
            "thinkingLevel: high",
            'excludeTools: ["web_search"]',
            'includeTools: ["code_lens", "git"]',
            "---",
            "You are a scout agent.",
        ].join("\n");

        const profile = parseProfile(content, "scout.md");

        expect(profile).toEqual({
            id: "scout",
            name: "Scout Agent",
            provider: "openai",
            model: "gpt-4o",
            thinkingLevel: "high",
            systemPrompt: "You are a scout agent.",
            excludeTools: ["web_search"],
            includeTools: ["code_lens", "git"],
        });
    });

    it("applies defaults when only required fields are present", () => {
        const content = [
            "---",
            "provider: anthropic",
            "model: claude-sonnet-4-20250514",
            "---",
            "System instructions here.",
        ].join("\n");

        const profile = parseProfile(content, "default.md");

        expect(profile.id).toBe("default");
        expect(profile.name).toBe("default");
        expect(profile.provider).toBe("anthropic");
        expect(profile.model).toBe("claude-sonnet-4-20250514");
        expect(profile.thinkingLevel).toBe("medium");
        expect(profile.systemPrompt).toBe("System instructions here.");
        expect(profile.excludeTools).toEqual([]);
        expect(profile.includeTools).toEqual([]);
    });

    it("uses frontmatter name over filename when provided", () => {
        const content = [
            "---",
            "name: My Custom Name",
            "provider: openai",
            "model: gpt-4o-mini",
            "---",
            "Body.",
        ].join("\n");

        const profile = parseProfile(content, "file.md");
        expect(profile.name).toBe("My Custom Name");
        expect(profile.id).toBe("file");
    });

    it("throws on missing provider", () => {
        const content = [
            "---",
            "model: gpt-4o",
            "---",
            "Body.",
        ].join("\n");

        expect(() => parseProfile(content, "no-provider.md")).toThrow(
            /missing required frontmatter field "provider"/,
        );
    });

    it("throws on missing model", () => {
        const content = [
            "---",
            "provider: openai",
            "---",
            "Body.",
        ].join("\n");

        expect(() => parseProfile(content, "no-model.md")).toThrow(
            /missing required frontmatter field "model"/,
        );
    });

    it("extracts multiline systemPrompt body correctly", () => {
        const content = [
            "---",
            "provider: openai",
            "model: gpt-4o",
            "---",
            "Line 1 of the prompt.",
            "Line 2 of the prompt.",
            "",
            "Line 4 after blank line.",
        ].join("\n");

        const profile = parseProfile(content, "multi.md");

        expect(profile.systemPrompt).toBe(
            "Line 1 of the prompt.\nLine 2 of the prompt.\n\nLine 4 after blank line.",
        );
    });

    it("trims leading/trailing whitespace from systemPrompt", () => {
        const content = [
            "---",
            "provider: openai",
            "model: gpt-4o",
            "---",
            "",
            "  Trimmed prompt content  ",
            "",
        ].join("\n");

        const profile = parseProfile(content, "trim.md");
        expect(profile.systemPrompt).toBe("Trimmed prompt content");
    });

    it("handles excludeTools and includeTools arrays", () => {
        const content = [
            "---",
            "provider: openai",
            "model: gpt-4o",
            'excludeTools: ["tool_a", "tool_b"]',
            'includeTools: ["tool_c"]',
            "---",
            "Body.",
        ].join("\n");

        const profile = parseProfile(content, "tools.md");
        expect(profile.excludeTools).toEqual(["tool_a", "tool_b"]);
        expect(profile.includeTools).toEqual(["tool_c"]);
    });

    it("defaults excludeTools and includeTools to empty arrays", () => {
        const content = [
            "---",
            "provider: openai",
            "model: gpt-4o",
            "---",
            "Body.",
        ].join("\n");

        const profile = parseProfile(content, "no-tools.md");
        expect(profile.excludeTools).toEqual([]);
        expect(profile.includeTools).toEqual([]);
    });

    it("validates thinkingLevel against allowed values", () => {
        const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];

        for (const level of valid) {
            const content = [
                "---",
                "provider: openai",
                "model: gpt-4o",
                `thinkingLevel: ${level}`,
                "---",
                "Body.",
            ].join("\n");

            const profile = parseProfile(content, "valid.md");
            expect(profile.thinkingLevel).toBe(level);
        }
    });

    it("throws on invalid thinkingLevel", () => {
        const content = [
            "---",
            "provider: openai",
            "model: gpt-4o",
            "thinkingLevel: extreme",
            "---",
            "Body.",
        ].join("\n");

        expect(() => parseProfile(content, "bad-level.md")).toThrow(
            /invalid thinkingLevel "extreme"/,
        );
    });
});

// ─── loadProfiles ───────────────────────────────────────────────────────────

describe("loadProfiles", () => {
    it("loads all .md files from a directory", async () => {
        await writeFile(
            join(tempDir, "alpha.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "---",
                "Alpha prompt.",
            ].join("\n"),
        );

        await writeFile(
            join(tempDir, "beta.md"),
            [
                "---",
                "provider: anthropic",
                "model: claude-sonnet-4-20250514",
                "---",
                "Beta prompt.",
            ].join("\n"),
        );

        // Non-.md files should be ignored
        await writeFile(join(tempDir, "notes.txt"), "not a profile");
        await writeFile(
            join(tempDir, "config.json"),
            JSON.stringify({ key: "value" }),
        );

        const profiles = await loadProfiles(tempDir);

        expect(profiles.size).toBe(2);
        expect(profiles.has("alpha")).toBe(true);
        expect(profiles.has("beta")).toBe(true);
        expect(profiles.get("alpha")!.provider).toBe("openai");
        expect(profiles.get("beta")!.provider).toBe("anthropic");
    });

    it("returns an empty map for a directory with no .md files", async () => {
        await writeFile(join(tempDir, "readme.txt"), "nothing here");

        const profiles = await loadProfiles(tempDir);
        expect(profiles.size).toBe(0);
    });

    it("throws on nonexistent directory", async () => {
        await expect(loadProfiles("/nonexistent/path/abc123")).rejects.toThrow(
            /Directory does not exist/,
        );
    });

    it("throws when path is a file, not a directory", async () => {
        const filePath = join(tempDir, "file.txt");
        await writeFile(filePath, "content");

        await expect(loadProfiles(filePath)).rejects.toThrow(/Path is not a directory/);
    });
});

// ─── loadProfile ────────────────────────────────────────────────────────────

describe("loadProfile", () => {
    it("loads a single profile by id", async () => {
        await writeFile(
            join(tempDir, "target.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "name: Target Agent",
                "---",
                "Target system prompt.",
            ].join("\n"),
        );

        await writeFile(
            join(tempDir, "other.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o-mini",
                "---",
                "Other.",
            ].join("\n"),
        );

        const profile = await loadProfile(tempDir, "target");

        expect(profile.id).toBe("target");
        expect(profile.name).toBe("Target Agent");
        expect(profile.systemPrompt).toBe("Target system prompt.");
    });

    it("throws when profile id is not found", async () => {
        await writeFile(
            join(tempDir, "exists.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "---",
                "Body.",
            ].join("\n"),
        );

        await expect(loadProfile(tempDir, "does-not-exist")).rejects.toThrow(
            /Profile "does-not-exist" not found/,
        );
    });
});

// ─── loadProfilesFromDirs ──────────────────────────────────────────────────

describe("loadProfilesFromDirs", () => {
    it("loads profiles from two directories, local overrides global when same ID", async () => {
        const globalDir = join(tempDir, `global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const localDir = join(tempDir, `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(globalDir, { recursive: true });
        await mkdir(localDir, { recursive: true });

        // Global has "shared" and "global-only" profiles
        await writeFile(
            join(globalDir, "shared.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "name: Global Shared",
                "---",
                "Global shared prompt.",
            ].join("\n"),
        );
        await writeFile(
            join(globalDir, "global-only.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "---",
                "Global only prompt.",
            ].join("\n"),
        );

        // Local overrides "shared" and adds "local-only"
        await writeFile(
            join(localDir, "shared.md"),
            [
                "---",
                "provider: anthropic",
                "model: claude-sonnet-4-20250514",
                "name: Local Shared",
                "---",
                "Local shared prompt.",
            ].join("\n"),
        );
        await writeFile(
            join(localDir, "local-only.md"),
            [
                "---",
                "provider: anthropic",
                "model: claude-sonnet-4-20250514",
                "---",
                "Local only prompt.",
            ].join("\n"),
        );

        // [local, global] → local is first, global is second
        // Reverse iteration processes global first, then local overrides
        const profiles = await loadProfilesFromDirs([localDir, globalDir]);

        expect(profiles.size).toBe(3);
        expect(profiles.get("shared")!.name).toBe("Local Shared");
        expect(profiles.get("shared")!.provider).toBe("anthropic");
        expect(profiles.has("global-only")).toBe(true);
        expect(profiles.has("local-only")).toBe(true);
    });

    it("returns profiles from global-only when local dir doesn't exist", async () => {
        const globalDir = join(tempDir, `global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const localDir = join(tempDir, `local-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(globalDir, { recursive: true });
        // localDir intentionally not created

        await writeFile(
            join(globalDir, "agent.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "---",
                "Agent prompt.",
            ].join("\n"),
        );

        const profiles = await loadProfilesFromDirs([localDir, globalDir]);

        expect(profiles.size).toBe(1);
        expect(profiles.has("agent")).toBe(true);
    });

    it("returns empty map when neither dir exists", async () => {
        const fakeA = join(tempDir, `nope-a-${Date.now()}`);
        const fakeB = join(tempDir, `nope-b-${Date.now()}`);

        const profiles = await loadProfilesFromDirs([fakeA, fakeB]);

        expect(profiles.size).toBe(0);
    });

    it("skips non-directory paths silently", async () => {
        const validDir = join(tempDir, `valid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(validDir, { recursive: true });

        // Create a file (not a directory) to pass as a dir path
        const filePath = join(tempDir, `not-a-dir-${Date.now()}.txt`);
        await writeFile(filePath, "I am a file");

        await writeFile(
            join(validDir, "agent.md"),
            [
                "---",
                "provider: openai",
                "model: gpt-4o",
                "---",
                "Agent prompt.",
            ].join("\n"),
        );

        const profiles = await loadProfilesFromDirs([validDir, filePath]);

        expect(profiles.size).toBe(1);
        expect(profiles.has("agent")).toBe(true);
    });

    it("re-throws unexpected errors from loadProfiles", async () => {
        const badDir = join(tempDir, `bad-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(badDir, { recursive: true });

        // Create a .md file with missing required provider field
        await writeFile(
            join(badDir, "broken.md"),
            [
                "---",
                "model: gpt-4o",
                "---",
                "Missing provider.",
            ].join("\n"),
        );

        await expect(loadProfilesFromDirs([badDir])).rejects.toThrow(
            /missing required frontmatter field "provider"/,
        );
    });

    it("returns empty map for empty dirs array", async () => {
        const profiles = await loadProfilesFromDirs([]);
        expect(profiles.size).toBe(0);
    });
});
