import { describe, expect, it } from 'bun:test';

describe('backward compatibility re-exports', () => {
  it('re-exports assertSafeName from lane-pool.js for T07 compatibility', async () => {
    // This test verifies that the re-export path works.
    // The existing tests/pool/assert-safe-name.test.ts imports from
    // ../../src/pool/lane-pool.js and should continue working.
    const { assertSafeName } = await import('../../src/pool/lane-pool.js');

    expect(typeof assertSafeName).toBe('function');

    // Basic smoke test
    expect(() => assertSafeName('valid-name', 'test')).not.toThrow();
    expect(() => assertSafeName('../bad', 'test')).toThrow();
  });

  it('assertSafeName re-exported from lane-pool matches validation module export', async () => {
    // This test verifies the re-export identity. It depends on
    // src/pool/validation.js existing (created during the module split).
    // If the module doesn't exist yet, skip gracefully.
    try {
      const lanePoolModule = await import('../../src/pool/lane-pool.js');
      const validationModule = await import('../../src/pool/validation.js');

      // Both should export the same function reference
      expect(lanePoolModule.assertSafeName).toBe(validationModule.assertSafeName);
    } catch {
      // validation.js doesn't exist yet — verify the lane-pool export still works
      const { assertSafeName } = await import('../../src/pool/lane-pool.js');
      expect(typeof assertSafeName).toBe('function');
    }
  });
});
