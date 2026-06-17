// ─── assignSequentialTaskIds Tests ──────────────────────────────────────────

import { describe, expect, it } from 'bun:test';
import { assignSequentialTaskIds } from '../../packages/engine/src/core/task-ids.js';

// A representative task shape that satisfies the generic constraint
// (id + dependencies) while also carrying an extra field, so we can verify
// that arbitrary properties are preserved through the transform.
interface TestTask {
  id: string;
  dependencies: string[];
  title: string;
}

function makeTask(id: string, dependencies: string[] = [], title = `Task ${id}`): TestTask {
  return { id, dependencies, title };
}

// ─── assignSequentialTaskIds ────────────────────────────────────────────────

describe('assignSequentialTaskIds', () => {
  // ─── Empty / Single ──────────────────────────────────────────────────

  it('returns an empty array when given an empty array', () => {
    const result = assignSequentialTaskIds<TestTask>([]);
    expect(result).toEqual([]);
  });

  it('renumbers a single task to t-01', () => {
    const tasks = [makeTask('anything')];
    const result = assignSequentialTaskIds(tasks);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('t-01');
  });

  // ─── Sequential Zero-Padded IDs ──────────────────────────────────────

  it('renumbers multiple tasks to t-01, t-02, t-03 in input order', () => {
    const tasks = [makeTask('alpha'), makeTask('bravo'), makeTask('charlie')];
    const result = assignSequentialTaskIds(tasks);
    expect(result.map((t) => t.id)).toEqual(['t-01', 't-02', 't-03']);
  });

  it('produces two-digit zero-padded IDs for indices 1-9', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => makeTask(`orig-${i + 1}`));
    const result = assignSequentialTaskIds(tasks);
    expect(result.map((t) => t.id)).toEqual(['t-01', 't-02', 't-03', 't-04', 't-05', 't-06', 't-07', 't-08', 't-09']);
  });

  it('does not over-pad double-digit indices (t-10, t-11)', () => {
    // padStart(2, '0') leaves already-two-digit numbers untouched: 10 -> '10'
    const tasks = Array.from({ length: 11 }, (_, i) => makeTask(`orig-${i + 1}`));
    const result = assignSequentialTaskIds(tasks);
    expect(result[9]!.id).toBe('t-10');
    expect(result[10]!.id).toBe('t-11');
  });

  it('assigns IDs based on array position, not the original id values', () => {
    // Original ids are in reverse "logical" order; new ids follow array order.
    const tasks = [makeTask('zeta'), makeTask('yesterday'), makeTask('apple')];
    const result = assignSequentialTaskIds(tasks);
    expect(result.map((t) => t.id)).toEqual(['t-01', 't-02', 't-03']);
  });

  // ─── Dependency Remapping ────────────────────────────────────────────

  it('remaps dependencies that reference other task ids', () => {
    const tasks = [makeTask('setup', []), makeTask('build', ['setup']), makeTask('deploy', ['build', 'setup'])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.dependencies).toEqual([]);
    expect(result[1]!.dependencies).toEqual(['t-01']);
    expect(result[2]!.dependencies).toEqual(['t-02', 't-01']);
  });

  it('leaves dependencies unchanged when they reference ids not in the task set', () => {
    const tasks = [makeTask('a', ['external-dep', 'unknown-2']), makeTask('b', [])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.dependencies).toEqual(['external-dep', 'unknown-2']);
  });

  it('remaps known dependencies and leaves unknown ones unchanged in the same array', () => {
    const tasks = [makeTask('a', []), makeTask('b', ['a', 'ghost', 'nonexistent'])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[1]!.dependencies).toEqual(['t-01', 'ghost', 'nonexistent']);
  });

  it('correctly remaps forward-referencing dependencies (depends on a later task)', () => {
    // The idMap is built from ALL tasks first, so forward refs resolve.
    const tasks = [makeTask('first', ['second']), makeTask('second', ['third']), makeTask('third', [])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.dependencies).toEqual(['t-02']);
    expect(result[1]!.dependencies).toEqual(['t-03']);
    expect(result[2]!.dependencies).toEqual([]);
  });

  it("remaps a self-referencing dependency to the task's own new id", () => {
    const tasks = [makeTask('self', ['self'])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.dependencies).toEqual(['t-01']);
  });

  it('returns a new (empty) dependencies array for tasks with no dependencies', () => {
    const tasks = [makeTask('a', []), makeTask('b', [])];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.dependencies).toEqual([]);
    expect(result[0]!.dependencies).not.toBe(tasks[0]!.dependencies);
  });

  // ─── Non-Mutation ────────────────────────────────────────────────────

  it('does not mutate the input array', () => {
    const tasks = [makeTask('a', []), makeTask('b', ['a'])];
    const snapshot = tasks.map((t) => ({ ...t, dependencies: [...t.dependencies] }));
    assignSequentialTaskIds(tasks);
    expect(tasks).toHaveLength(snapshot.length);
    expect(tasks.map((t) => t.id)).toEqual(snapshot.map((t) => t.id));
  });

  it('does not mutate the input task objects (ids and dependencies unchanged)', () => {
    const taskA = makeTask('a', []);
    const taskB = makeTask('b', ['a', 'external']);
    const tasks = [taskA, taskB];
    assignSequentialTaskIds(tasks);
    // Original objects retain their original values.
    expect(taskA.id).toBe('a');
    expect(taskA.dependencies).toEqual([]);
    expect(taskB.id).toBe('b');
    expect(taskB.dependencies).toEqual(['a', 'external']);
  });

  it('does not mutate the original dependencies arrays in place', () => {
    const depsB = ['a', 'external'];
    const tasks = [makeTask('a', []), makeTask('b', depsB)];
    assignSequentialTaskIds(tasks);
    expect(depsB).toEqual(['a', 'external']);
    expect(depsB).toHaveLength(2);
  });

  it('returns new object references (not the same identity as inputs)', () => {
    const taskA = makeTask('a', []);
    const taskB = makeTask('b', ['a']);
    const tasks = [taskA, taskB];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]).not.toBe(taskA);
    expect(result[1]).not.toBe(taskB);
    expect(result).not.toBe(tasks);
  });

  // ─── Preserves Extra Properties (Generic T) ──────────────────────────

  it('preserves extra properties via the spread operator', () => {
    const tasks = [makeTask('a', [], 'Implement feature')];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]!.title).toBe('Implement feature');
  });

  it('preserves all extra properties across multiple tasks', () => {
    const tasks = [
      { id: 'x', dependencies: [], title: 'First', extra: 42, flag: true },
      { id: 'y', dependencies: ['x'], title: 'Second', extra: 99, flag: false },
    ];
    const result = assignSequentialTaskIds(tasks);
    expect(result[0]).toMatchObject({ id: 't-01', title: 'First', extra: 42, flag: true });
    expect(result[1]).toMatchObject({ id: 't-02', title: 'Second', extra: 99, flag: false });
    expect(result[1]!.dependencies).toEqual(['t-01']);
  });

  // ─── Ordering ────────────────────────────────────────────────────────

  it('returns results in the same order as the input', () => {
    const tasks = [makeTask('one'), makeTask('two'), makeTask('three'), makeTask('four')];
    const result = assignSequentialTaskIds(tasks);
    expect(result.map((t) => t.title)).toEqual(['Task one', 'Task two', 'Task three', 'Task four']);
    expect(result.map((t) => t.id)).toEqual(['t-01', 't-02', 't-03', 't-04']);
  });
});
