import { describe, expect, it } from 'bun:test';
// Import from the barrel (index.ts) to verify title-generator.ts is re-exported
import { TitleSchema, generateWorkflowTitle } from '../../src/index.js';

describe('title-generator module re-export from index.ts', () => {
  it('re-exports TitleSchema as a Zod schema', () => {
    expect(TitleSchema).toBeDefined();
    expect(typeof TitleSchema.safeParse).toBe('function');
  });

  it('re-exports generateWorkflowTitle as a function', () => {
    expect(typeof generateWorkflowTitle).toBe('function');
  });

  it('TitleSchema validates a correct input via barrel re-export', () => {
    const result = TitleSchema.safeParse({ title: 'Test Title' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Test Title');
    }
  });
});
