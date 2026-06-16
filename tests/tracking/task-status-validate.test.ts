import { describe, expect, it } from 'bun:test';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';
import { makeTask } from '../helpers/make-task.js';

describe('TaskTracker.validateAllDependencies', () => {
  it('does not throw when all dependencies reference existing tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'a' }));
    tracker.addTask(makeTask({ id: 'b' }));
    tracker.addTask(makeTask({ id: 'c', dependencies: ['a', 'b'] }));
    tracker.addTask(makeTask({ id: 'd', dependencies: ['c'] }));

    expect(() => tracker.validateAllDependencies()).not.toThrow();
  });

  it('does not throw for an empty tracker', () => {
    const tracker = new TaskTracker();
    expect(() => tracker.validateAllDependencies()).not.toThrow();
  });

  it('does not throw when no tasks have dependencies', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'x' }));
    tracker.addTask(makeTask({ id: 'y' }));

    expect(() => tracker.validateAllDependencies()).not.toThrow();
  });

  it('throws when a task references a non-existent dependency id', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'a', dependencies: ['ghost'] }));

    expect(() => tracker.validateAllDependencies()).toThrow(/ghost/);
  });

  it('throws an error whose message includes the offending task id', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'orphan-task', dependencies: ['nonexistent-dep'] }));

    try {
      tracker.validateAllDependencies();
      expect.fail('Expected validateAllDependencies to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('orphan-task');
    }
  });

  it('throws an error whose message includes the missing dependency id', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'task-a', dependencies: ['missing-dep'] }));

    try {
      tracker.validateAllDependencies();
      expect.fail('Expected validateAllDependencies to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('missing-dep');
    }
  });

  it('reports multiple violations when several tasks have bad deps', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'x', dependencies: ['phantom-1'] }));
    tracker.addTask(makeTask({ id: 'y', dependencies: ['phantom-2'] }));

    try {
      tracker.validateAllDependencies();
      expect.fail('Expected validateAllDependencies to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('x');
      expect(message).toContain('phantom-1');
      expect(message).toContain('y');
      expect(message).toContain('phantom-2');
    }
  });

  it('reports all missing deps for a single task with multiple bad references', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'multi', dependencies: ['nope-a', 'nope-b'] }));

    try {
      tracker.validateAllDependencies();
      expect.fail('Expected validateAllDependencies to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('multi');
      expect(message).toContain('nope-a');
      expect(message).toContain('nope-b');
    }
  });

  it('does NOT throw for mutually-referencing existing tasks (only checks referential integrity, not cycles)', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'a' }));
    tracker.addTask(makeTask({ id: 'b' }));

    // Manually create a circular reference — addTask would prevent this,
    // but validateAllDependencies only checks that dep IDs exist.
    tracker.getTask('a')!.dependencies = ['b'];
    tracker.getTask('b')!.dependencies = ['a'];

    // Both 'a' and 'b' exist → no referential integrity violation
    expect(() => tracker.validateAllDependencies()).not.toThrow();
  });

  it('does not throw after fromJSON round-trip with valid deps', () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ id: 'root' }));
    tracker.addTask(makeTask({ id: 'child', dependencies: ['root'] }));

    const json = tracker.toJSON();
    const restored = TaskTracker.fromJSON(json);

    expect(() => restored.validateAllDependencies()).not.toThrow();
  });
});
