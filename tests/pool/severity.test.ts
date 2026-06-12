import { describe, expect, it } from 'bun:test';
import { extractSeverity, isFailingSeverity } from '../../src/pool/severity.js';

describe('severity module', () => {
  describe('isFailingSeverity', () => {
    it('returns true for "critical"', () => {
      expect(isFailingSeverity('critical')).toBe(true);
    });

    it('returns true for "high"', () => {
      expect(isFailingSeverity('high')).toBe(true);
    });

    it('returns false for "medium"', () => {
      expect(isFailingSeverity('medium')).toBe(false);
    });

    it('returns false for "low"', () => {
      expect(isFailingSeverity('low')).toBe(false);
    });

    it('returns false for unknown severity strings', () => {
      expect(isFailingSeverity('unknown')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isFailingSeverity('')).toBe(false);
    });
  });

  describe('extractSeverity', () => {
    it('extracts severity string from an object with a severity field', () => {
      expect(extractSeverity({ severity: 'critical' })).toBe('critical');
    });

    it('extracts "high" severity', () => {
      expect(extractSeverity({ severity: 'high' })).toBe('high');
    });

    it('extracts "medium" severity', () => {
      expect(extractSeverity({ severity: 'medium' })).toBe('medium');
    });

    it('extracts "low" severity', () => {
      expect(extractSeverity({ severity: 'low' })).toBe('low');
    });

    it('returns "medium" when severity is not a string', () => {
      expect(extractSeverity({ severity: 42 })).toBe('medium');
    });

    it('returns "medium" when severity is undefined', () => {
      expect(extractSeverity({ severity: undefined })).toBe('medium');
    });

    it('returns "medium" when severity is null', () => {
      expect(extractSeverity({ severity: null })).toBe('medium');
    });

    it('returns "medium" when object has no severity field', () => {
      expect(extractSeverity({ approved: false, feedback: 'bad' })).toBe('medium');
    });

    it('returns "medium" for null input', () => {
      expect(extractSeverity(null)).toBe('medium');
    });

    it('returns "medium" for undefined input', () => {
      expect(extractSeverity(undefined)).toBe('medium');
    });

    it('returns "medium" for string input', () => {
      expect(extractSeverity('just a string')).toBe('medium');
    });

    it('returns "medium" for number input', () => {
      expect(extractSeverity(42)).toBe('medium');
    });

    it('returns "medium" for array input', () => {
      expect(extractSeverity([1, 2, 3])).toBe('medium');
    });

    it('extracts severity from object with extra fields', () => {
      expect(extractSeverity({ approved: false, feedback: 'fix', severity: 'high' })).toBe('high');
    });

    it('extracts severity from object with only severity', () => {
      expect(extractSeverity({ severity: 'low' })).toBe('low');
    });
  });

  describe('isFailingSeverity and extractSeverity integration', () => {
    it('critical output is failing', () => {
      const output = { approved: false, feedback: 'bad', severity: 'critical' };
      expect(isFailingSeverity(extractSeverity(output))).toBe(true);
    });

    it('high output is failing', () => {
      const output = { approved: false, feedback: 'bad', severity: 'high' };
      expect(isFailingSeverity(extractSeverity(output))).toBe(true);
    });

    it('medium output is not failing', () => {
      const output = { approved: false, feedback: 'minor', severity: 'medium' };
      expect(isFailingSeverity(extractSeverity(output))).toBe(false);
    });

    it('low output is not failing', () => {
      const output = { approved: false, feedback: 'nitpick', severity: 'low' };
      expect(isFailingSeverity(extractSeverity(output))).toBe(false);
    });

    it('missing severity defaults to medium (not failing)', () => {
      const output = { approved: false, feedback: 'meh' };
      expect(isFailingSeverity(extractSeverity(output))).toBe(false);
    });
  });
});
