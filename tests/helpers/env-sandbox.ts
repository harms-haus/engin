import { afterEach, beforeEach } from "bun:test";

/**
 * Creates a process.env sandbox that saves state in beforeEach and restores it in afterEach.
 * Call inside a describe() block to isolate env changes to that block's tests.
 */
export function useEnvSandbox(): void {
    let savedEnv: Record<string, string | undefined>;
    beforeEach(() => {
        savedEnv = { ...process.env };
    });
    afterEach(() => {
        const currentKeys = new Set(Object.keys(process.env));
        const originalKeys = new Set(Object.keys(savedEnv));
        for (const key of currentKeys) {
            if (!originalKeys.has(key)) delete process.env[key];
        }
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val !== undefined) process.env[key] = val;
        }
    });
}
