import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pi-ai module so we control env-key resolution in tests.
vi.mock("@earendil-works/pi-ai", () => ({
    getEnvApiKey: vi.fn(),
    findEnvKeys: vi.fn(),
}));

import { getEnvApiKey, findEnvKeys } from "@earendil-works/pi-ai";
import { resolveApiKey, resolveApiKeyOrThrow } from "../../src/core/auth.ts";

const mockGetEnvApiKey = vi.mocked(getEnvApiKey);
const mockFindEnvKeys = vi.mocked(findEnvKeys);

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── resolveApiKey ──────────────────────────────────────────────────────────

describe("resolveApiKey", () => {
    it("returns custom key when present", () => {
        const result = resolveApiKey("openai", { openai: "sk-custom" });
        expect(result).toBe("sk-custom");
        // Should NOT call getEnvApiKey because the custom key took precedence.
        expect(mockGetEnvApiKey).not.toHaveBeenCalled();
    });

    it("falls back to getEnvApiKey when custom key is absent", () => {
        mockGetEnvApiKey.mockReturnValue("sk-env");
        const result = resolveApiKey("anthropic", { openai: "sk-other" });
        expect(result).toBe("sk-env");
        expect(mockGetEnvApiKey).toHaveBeenCalledWith("anthropic");
    });

    it("returns undefined when no key is found anywhere", () => {
        mockGetEnvApiKey.mockReturnValue(undefined);
        const result = resolveApiKey("unknown-provider");
        expect(result).toBeUndefined();
    });

    it("returns undefined when customKeys is omitted", () => {
        mockGetEnvApiKey.mockReturnValue(undefined);
        const result = resolveApiKey("openai");
        expect(result).toBeUndefined();
        expect(mockGetEnvApiKey).toHaveBeenCalledWith("openai");
    });

    it("prefers custom key even when env key exists", () => {
        mockGetEnvApiKey.mockReturnValue("sk-env");
        const result = resolveApiKey("openai", { openai: "sk-custom" });
        expect(result).toBe("sk-custom");
    });
});

// ─── resolveApiKeyOrThrow ───────────────────────────────────────────────────

describe("resolveApiKeyOrThrow", () => {
    it("returns the key when found", () => {
        mockGetEnvApiKey.mockReturnValue("sk-env");
        expect(resolveApiKeyOrThrow("openai")).toBe("sk-env");
    });

    it("returns the custom key when provided", () => {
        expect(resolveApiKeyOrThrow("openai", { openai: "sk-custom" })).toBe(
            "sk-custom",
        );
    });

    it("throws a descriptive error when no key is found", () => {
        mockGetEnvApiKey.mockReturnValue(undefined);
        mockFindEnvKeys.mockReturnValue(["OPENAI_API_KEY"]);

        expect(() => resolveApiKeyOrThrow("openai")).toThrow(
            'No API key found for provider "openai"',
        );
    });

    it("includes env-var hints from findEnvKeys", () => {
        mockGetEnvApiKey.mockReturnValue(undefined);
        mockFindEnvKeys.mockReturnValue(["OPENAI_API_KEY", "OPENAI_ORG_KEY"]);

        try {
            resolveApiKeyOrThrow("openai");
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.message).toContain("OPENAI_API_KEY");
            expect(err.message).toContain("OPENAI_ORG_KEY");
        }
    });

    it("omits env-var section when findEnvKeys returns undefined", () => {
        mockGetEnvApiKey.mockReturnValue(undefined);
        mockFindEnvKeys.mockReturnValue(undefined);

        try {
            resolveApiKeyOrThrow("unknown");
            expect.fail("should have thrown");
        } catch (err: any) {
            expect(err.message).toContain("No API key found");
            expect(err.message).not.toContain("Expected environment variable");
        }
    });
});
