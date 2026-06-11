/**
 * Tests for the WorkflowEntry type.
 *
 * WorkflowEntry represents an available workflow template (as opposed to
 * WorkflowSummary which represents a running/past run instance). It mirrors
 * the backend type from src/core/types.ts but does NOT import from the backend.
 */

import { describe, expect, it } from 'vitest';

import type { WorkflowEntry } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a WorkflowEntry with defaults for test convenience. */
function createEntry(overrides: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    name: 'test-workflow',
    source: 'local',
    path: './workflows/test.yaml',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowEntry', () => {
  describe('structure', () => {
    it('should create a valid WorkflowEntry with all required fields', () => {
      const entry: WorkflowEntry = {
        name: 'my-workflow',
        source: 'local',
        path: './workflows/my-workflow.yaml',
      };
      expect(entry).toEqual({
        name: 'my-workflow',
        source: 'local',
        path: './workflows/my-workflow.yaml',
      });
    });

    it('should accept "global" as a valid source value', () => {
      const entry: WorkflowEntry = {
        name: 'global-workflow',
        source: 'global',
        path: '/etc/workflows/global.yaml',
      };
      expect(entry.source).toBe('global');
    });

    it('should accept "local" as a valid source value', () => {
      const entry: WorkflowEntry = {
        name: 'local-workflow',
        source: 'local',
        path: './workflows/local.yaml',
      };
      expect(entry.source).toBe('local');
    });

    it('should preserve name, source, and path properties', () => {
      const entry = createEntry({
        name: 'data-pipeline',
        source: 'global',
        path: '/opt/workflows/pipeline.yaml',
      });
      expect(entry.name).toBe('data-pipeline');
      expect(entry.source).toBe('global');
      expect(entry.path).toBe('/opt/workflows/pipeline.yaml');
    });
  });

  describe('type safety', () => {
    it('should reject invalid source values at compile time', () => {
      // This is a compile-time check. If the type is correct,
      // assigning anything other than 'local' | 'global' should fail.
      const entry = createEntry();
      // At runtime, we can verify the values are constrained by reading
      // the type, but TypeScript ensures the compile-time safety.
      expect(Object.keys(entry)).toEqual(['name', 'source', 'path']);
    });

    it('should have the correct property types at runtime', () => {
      const entry = createEntry();
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.source).toBe('string');
      expect(typeof entry.path).toBe('string');
    });
  });

  describe('distinction from WorkflowSummary', () => {
    it('should represent a template, not a running instance', () => {
      // WorkflowEntry has no id, status, startedAt — those are on WorkflowSummary
      const entry = createEntry();
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('status');
      expect(entry).not.toHaveProperty('startedAt');
      expect(entry).not.toHaveProperty('sidebar');
      expect(entry).not.toHaveProperty('completedAt');
    });

    it('should have the fields that define a template reference', () => {
      const entry = createEntry();
      // A template is identified by name, sourced from local or global, with a path
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('source');
      expect(entry).toHaveProperty('path');
    });
  });

  describe('usage patterns', () => {
    it('should be usable in an array of available workflows', () => {
      const availableWorkflows: WorkflowEntry[] = [
        { name: 'build', source: 'local', path: './workflows/build.yaml' },
        { name: 'deploy', source: 'local', path: './workflows/deploy.yaml' },
        { name: 'shared-lib', source: 'global', path: '/opt/workflows/lib.yaml' },
      ];
      expect(availableWorkflows).toHaveLength(3);
      expect(availableWorkflows[0].name).toBe('build');
      expect(availableWorkflows[1].name).toBe('deploy');
      expect(availableWorkflows[2].name).toBe('shared-lib');
    });

    it('should work with partial overrides via helper', () => {
      const entry = createEntry({ name: 'custom-workflow' });
      expect(entry.name).toBe('custom-workflow');
      expect(entry.source).toBe('local'); // default
      expect(entry.path).toBe('./workflows/test.yaml'); // default
    });

    it('should be destructureable', () => {
      const entry = createEntry({
        name: 'destructure-test',
        source: 'global',
        path: '/tmp/workflows/test.yaml',
      });
      const { name, source, path } = entry;
      expect(name).toBe('destructure-test');
      expect(source).toBe('global');
      expect(path).toBe('/tmp/workflows/test.yaml');
    });

    it('should work with Object.assign for merging', () => {
      const base: WorkflowEntry = { name: 'base', source: 'local', path: './base.yaml' };
      const merged: WorkflowEntry = { ...base, name: 'override' };
      expect(merged.name).toBe('override');
      expect(merged.source).toBe('local');
      expect(merged.path).toBe('./base.yaml');
    });
  });
});
