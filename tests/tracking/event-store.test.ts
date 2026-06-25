import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

describe('EventStore', () => {
  const { getDir } = useTempDir();
  let dir: string;

  beforeEach(() => {
    dir = getDir();
  });

  // ── append ──────────────────────────────────────────────────────────

  describe('append', () => {
    it('returns an EventRecord with seq starting at 1', () => {
      const store = new EventStore(dir);
      const rec = store.append('workflow_started', { taskPrompt: 'hello' });
      expect(rec.seq).toBe(1);
      expect(rec.type).toBe('workflow_started');
      expect(rec.data.taskPrompt).toBe('hello');
      expect(rec.metadata.timestamp).toBeDefined();
      expect(new Date(rec.metadata.timestamp).toISOString()).toBe(rec.metadata.timestamp);
    });

    it('increments seq monotonically', () => {
      const store = new EventStore(dir);
      const r1 = store.append('workflow_started', { taskPrompt: 'a' });
      const r2 = store.append('phase_started', { phase: 'scouting' });
      const r3 = store.append('phase_completed', { phase: 'scouting', durationMs: 100 });
      expect(r1.seq).toBe(1);
      expect(r2.seq).toBe(2);
      expect(r3.seq).toBe(3);
    });

    it('includes optional metadata', () => {
      const store = new EventStore(dir);
      const rec = store.append('decision', { decision: 'use X' }, { agentId: 'a1', taskId: 't1', phaseId: 'impl' });
      expect(rec.metadata.agentId).toBe('a1');
      expect(rec.metadata.taskId).toBe('t1');
      expect(rec.metadata.phaseId).toBe('impl');
    });

    it('appends a JSONL line to events.jsonl', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'test' });
      store.append('phase_started', { phase: 'scouting' });
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);

      const rec1 = JSON.parse(lines[0]);
      expect(rec1.type).toBe('workflow_started');
      expect(rec1.seq).toBe(1);

      const rec2 = JSON.parse(lines[1]);
      expect(rec2.type).toBe('phase_started');
      expect(rec2.seq).toBe(2);
    });

    // ── write coalescing (F2) ──────────────────────────────────────────

    it('coalesces multiple synchronous appends into one durable write', async () => {
      const store = new EventStore(dir);
      // Five synchronous appends within the same tick should be accumulated
      // and flushed as a single appendFile payload.
      for (let i = 0; i < 5; i++) {
        store.append('sidebar_updated', { title: `t${i}` });
      }
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(5);
      // Verify seq ordering is preserved
      for (let i = 0; i < 5; i++) {
        const rec = JSON.parse(lines[i]);
        expect(rec.seq).toBe(i + 1);
        expect(rec.data.title).toBe(`t${i}`);
      }
    });

    it('flush() drains synchronously when called immediately after append', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'immediate' });
      // flush() called before the scheduled microtask fires — should still persist.
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const rec = JSON.parse(raw.trim());
      expect(rec.type).toBe('workflow_started');
      expect(rec.data.taskPrompt).toBe('immediate');
    });

    it('flush() persists appends accumulated across separate ticks', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'first' });
      await store.flush();

      await new Promise<void>((r) => setTimeout(r, 1));
      store.append('phase_started', { phase: 'p' });
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).seq).toBe(1);
      expect(JSON.parse(lines[1]).seq).toBe(2);
    });

    it('updates the projection via evolve', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'Build app' });
      const proj = store.getProjection();
      expect(proj.taskPrompt).toBe('Build app');
      expect(proj.status).toBe('running');
    });

    it('swallows disk write errors (fire-and-forget)', () => {
      // Use a path that will fail to write (read-only directory would be complex,
      // so we just verify append doesn't throw when given weird paths)
      const store = new EventStore('/nonexistent/deep/path/that/should/not/exist');
      // This should not throw — fire-and-forget
      expect(() => store.append('workflow_started', { taskPrompt: 'x' })).not.toThrow();
    });
  });

  // ── subscribe ──────────────────────────────────────────────────────

  describe('subscribe', () => {
    it('notifies subscribers on append', () => {
      const store = new EventStore(dir);
      const received: string[] = [];
      store.subscribe((proj) => {
        received.push(proj.taskPrompt);
      });

      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('workflow_started', { taskPrompt: 'b' });

      expect(received).toEqual(['a', 'b']);
    });

    it('unsubscribe stops notifications', () => {
      const store = new EventStore(dir);
      let count = 0;
      const unsub = store.subscribe(() => {
        count++;
      });

      store.append('workflow_started', { taskPrompt: 'a' });
      expect(count).toBe(1);

      unsub();
      store.append('workflow_started', { taskPrompt: 'b' });
      expect(count).toBe(1); // no new notification
    });

    it('supports multiple subscribers', () => {
      const store = new EventStore(dir);
      let a = 0;
      let b = 0;
      store.subscribe(() => {
        a++;
      });
      store.subscribe(() => {
        b++;
      });

      store.append('workflow_started', { taskPrompt: 'x' });
      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  });

  // ── getProjection / getSnapshot ────────────────────────────────────

  describe('getProjection / getSnapshot', () => {
    it('getProjection returns the current state', () => {
      const store = new EventStore(dir);
      const proj = store.getProjection();
      expect(proj.taskPrompt).toBe('');
      expect(proj.status).toBe('running');
      expect(proj.seq).toBe(0);

      store.append('workflow_started', { taskPrompt: 'hello' });
      expect(store.getProjection().taskPrompt).toBe('hello');
      expect(store.getProjection().seq).toBe(1);
    });

    it('getSnapshot returns state + seq', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'x' });
      const snap = store.getSnapshot();
      expect(snap.seq).toBe(1);
      expect(snap.state.taskPrompt).toBe('x');
    });
  });

  // ── getEventsSince ─────────────────────────────────────────────────

  describe('getEventsSince', () => {
    it('returns events with seq > given', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('phase_started', { phase: 'scouting' });
      store.append('phase_completed', { phase: 'scouting' });

      const since2 = store.getEventsSince(2);
      expect(since2).toHaveLength(1);
      expect(since2[0].seq).toBe(3);
      expect(since2[0].type).toBe('phase_completed');
    });

    it('returns all events when seq is 0', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'a' });
      store.append('phase_started', { phase: 'scouting' });

      const all = store.getEventsSince(0);
      expect(all).toHaveLength(2);
    });

    it('returns empty when seq >= latest', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'a' });

      const empty = store.getEventsSince(1);
      expect(empty).toEqual([]);
    });

    it('returns all available when seq is older than buffer', () => {
      const store = new EventStore(dir, { maxRingBuffer: 3 });
      store.append('workflow_started', { taskPrompt: '1' });
      store.append('phase_started', { phase: 'a' });
      store.append('phase_completed', { phase: 'a' });
      store.append('phase_started', { phase: 'b' }); // evicts seq=1
      store.append('phase_completed', { phase: 'b' }); // evicts seq=2

      // seq 1 was evicted — should return everything available (seq 3, 4, 5)
      const events = store.getEventsSince(1);
      expect(events.length).toBeGreaterThanOrEqual(2); // at least the most recent
      expect(events[0].seq).toBeGreaterThanOrEqual(3);
    });

    // ── binary-search edge cases (F3) ───────────────────────────────────

    it('binary search: returns correct slice from the middle (gap scenario)', () => {
      // A gap in the *argument* (not the buffer) — seq not present in buffer.
      const store = new EventStore(dir);
      for (let i = 0; i < 10; i++) {
        store.append('sidebar_updated', { title: `t${i}` }); // seq 1..10
      }
      // arg=5 → first record with seq > 5 is seq 6 (index 5)
      const events = store.getEventsSince(5);
      expect(events).toHaveLength(5);
      expect(events[0].seq).toBe(6);
      expect(events[4].seq).toBe(10);
    });

    it('binary search: returns correct slice with seq beyond current', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'a' }); // seq 1
      store.append('phase_started', { phase: 'p' }); // seq 2

      // arg beyond the latest seq → empty
      const events = store.getEventsSince(99);
      expect(events).toEqual([]);
    });

    it('binary search: returns correct slice with contiguous seqs', () => {
      const store = new EventStore(dir);
      for (let i = 1; i <= 5; i++) {
        store.append('sidebar_updated', { title: `t${i}` }); // seq 1..5
      }
      const events = store.getEventsSince(2);
      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(3);
      expect(events[2].seq).toBe(5);
    });

    it('binary search: handles buffer with evicted prefix correctly', () => {
      const store = new EventStore(dir, { maxRingBuffer: 3 });
      for (let i = 0; i < 10; i++) {
        store.append('sidebar_updated', { title: `t${i}` }); // seq 1..10, buffer has 8,9,10
      }
      // arg within the buffer → slice from there
      const events = store.getEventsSince(8);
      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(9);
      expect(events[1].seq).toBe(10);
    });

    it('binary search: returns empty for empty buffer', () => {
      const store = new EventStore(dir);
      const events = store.getEventsSince(0);
      expect(events).toEqual([]);
    });
  });

  // ── ring buffer eviction ───────────────────────────────────────────

  describe('ring buffer', () => {
    it('evicts oldest events when capacity is exceeded', () => {
      const store = new EventStore(dir, { maxRingBuffer: 3 });
      store.append('workflow_started', { taskPrompt: '1' });
      store.append('phase_started', { phase: 'a' });
      store.append('phase_completed', { phase: 'a' });
      store.append('phase_started', { phase: 'b' }); // 4th event — evicts seq 1
      store.append('phase_completed', { phase: 'b' }); // 5th — evicts seq 2

      const all = store.getEventsSince(0);
      expect(all).toHaveLength(3); // only 3 in buffer
      expect(all[0].seq).toBe(3);
      expect(all[2].seq).toBe(5);
    });

    it('default capacity is 1000', () => {
      const store = new EventStore(dir);
      // Append 1000 events — buffer stays at 1000 (below hysteresis threshold)
      for (let i = 0; i < 1000; i++) {
        store.append('workflow_started', { taskPrompt: `event-${i}` });
      }
      const all = store.getEventsSince(0);
      expect(all).toHaveLength(1000);

      // 1001st event does NOT evict yet (hysteresis: trim at 1100 * 1.1 = 1100)
      store.append('workflow_started', { taskPrompt: 'just-over' });
      const after1001 = store.getEventsSince(0);
      expect(after1001).toHaveLength(1001);
      expect(after1001[0].seq).toBe(1);

      // Append until we exceed the hysteresis threshold (1101 events)
      for (let i = 0; i < 100; i++) {
        store.append('workflow_started', { taskPrompt: `pad-${i}` });
      }
      // 1101 events → trim fires, back to 1000
      const afterTrim = store.getEventsSince(0);
      expect(afterTrim).toHaveLength(1000);
      expect(afterTrim[0].seq).toBe(102); // first 101 evicted
    });
  });

  // ── snapshot save/load ─────────────────────────────────────────────

  describe('snapshot save/load', () => {
    it('saveSnapshot writes to event-snapshot.json', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'snap test' });
      await store.saveSnapshot();

      const raw = await fs.readFile(path.join(dir, 'event-snapshot.json'), 'utf-8');
      const snap = JSON.parse(raw);
      expect(snap.seq).toBe(1);
      expect(snap.state.taskPrompt).toBe('snap test');
      expect(snap.timestamp).toBeDefined();
    });

    it('load restores from snapshot + replays subsequent events', async () => {
      // Build up some events
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'original' });
      store1.append('phase_started', { phase: 'scouting' });
      await store1.saveSnapshot();

      // Add more events after snapshot
      store1.append('phase_completed', { phase: 'scouting', durationMs: 100 });
      store1.append('phase_started', { phase: 'planning' });
      await store1.flush();

      // Load should restore from snapshot + replay seq 3, 4
      const store2 = await EventStore.load(dir);
      expect(store2.getProjection().taskPrompt).toBe('original');
      expect(store2.getProjection().currentPhaseId).toBe('planning');
      expect(store2.getProjection().completedPhaseIds).toEqual(['scouting']);
      expect(store2.getProjection().seq).toBe(4);
    });

    it('load returns a fresh store when no files exist', async () => {
      const store = await EventStore.load(dir);
      const proj = store.getProjection();
      expect(proj.taskPrompt).toBe('');
      expect(proj.status).toBe('running');
      expect(proj.seq).toBe(0);
    });

    // ── snapshot version-gating ────────────────────────────────────────

    it('saveSnapshot includes version field', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'v2 snapshot' });
      await store.saveSnapshot();

      const raw = await fs.readFile(path.join(dir, 'event-snapshot.json'), 'utf-8');
      const snap = JSON.parse(raw);
      expect(snap).toHaveProperty('version', 2);
    });

    it('loads snapshot with matching version normally', async () => {
      // Create events, save snapshot (which includes version)
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'versioned' });
      store1.append('phase_started', { phase: 'scouting' });
      await store1.flush();
      await store1.saveSnapshot();

      // Add a subsequent event AFTER the snapshot — this should be replayed
      // from JSONL on load, while pre-snapshot state comes from the snapshot.
      store1.append('phase_completed', { phase: 'scouting', durationMs: 100 });
      await store1.flush();

      // Load should restore from snapshot + replay seq 3
      const store2 = await EventStore.load(dir);
      expect(store2.getProjection().taskPrompt).toBe('versioned');
      expect(store2.getProjection().currentPhaseId).toBe('scouting');
      expect(store2.getProjection().completedPhaseIds).toEqual(['scouting']);
      expect(store2.getProjection().seq).toBe(3);
    });

    it('discards snapshot with missing version and replays from JSONL', async () => {
      // Create events, flush them to disk, then save snapshot
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'old snapshot' });
      store1.append('phase_started', { phase: 'scouting' });
      await store1.flush();
      await store1.saveSnapshot();

      // Manually write an additional event AFTER the snapshot point to JSONL
      const extraRec = {
        seq: 3,
        type: 'phase_completed',
        data: { phase: 'scouting', durationMs: 100 },
        metadata: { timestamp: new Date().toISOString() },
      };
      await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(extraRec) + '\n', 'utf-8');

      // Remove the version field from the snapshot (simulating old format)
      const snapshotPath = path.join(dir, 'event-snapshot.json');
      const raw = await fs.readFile(snapshotPath, 'utf-8');
      const snap = JSON.parse(raw);
      delete snap.version;
      await fs.writeFile(snapshotPath, JSON.stringify(snap, null, 2), 'utf-8');

      // Spy on console.debug to verify the discard message
      const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});

      // Load — should discard the old-format snapshot and replay all events
      const store2 = await EventStore.load(dir);

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith('[EventStore] Discarding snapshot with version', undefined, 'expected', 2);
      debugSpy.mockRestore();

      // The projection should reflect ALL events (seq 1, 2, 3) replayed.
      // phase_started sets currentPhaseId to 'scouting', then phase_completed
      // does NOT clear it — so currentPhaseId remains 'scouting'.
      expect(store2.getProjection().taskPrompt).toBe('old snapshot');
      expect(store2.getProjection().currentPhaseId).toBe('scouting');
      expect(store2.getProjection().completedPhaseIds).toEqual(['scouting']);
      expect(store2.getProjection().seq).toBe(3);
    });

    it('discards snapshot with wrong version number and replays from JSONL', async () => {
      // Create events, flush them to disk, then save snapshot
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'wrong version' });
      store1.append('phase_started', { phase: 'testing' });
      await store1.flush();
      await store1.saveSnapshot();

      // Manually add more events to JSONL
      const extraRec = {
        seq: 3,
        type: 'phase_completed',
        data: { phase: 'testing', durationMs: 50 },
        metadata: { timestamp: new Date().toISOString() },
      };
      await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(extraRec) + '\n', 'utf-8');

      // Change version field to an old/wrong value
      const snapshotPath = path.join(dir, 'event-snapshot.json');
      const raw = await fs.readFile(snapshotPath, 'utf-8');
      const snap = JSON.parse(raw);
      snap.version = 1;
      await fs.writeFile(snapshotPath, JSON.stringify(snap, null, 2), 'utf-8');

      const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});

      const store2 = await EventStore.load(dir);

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith('[EventStore] Discarding snapshot with version', 1, 'expected', 2);
      debugSpy.mockRestore();

      // All events replayed from JSONL
      expect(store2.getProjection().taskPrompt).toBe('wrong version');
      expect(store2.getProjection().seq).toBe(3);
    });

    it('replays ALL events from JSONL when snapshot is discarded (snapshotSeq=0)', async () => {
      // Create events, flush them to disk, then save snapshot
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'full replay' });
      store1.append('phase_started', { phase: 'alpha' });
      store1.append('phase_completed', { phase: 'alpha', durationMs: 200 });
      store1.append('phase_started', { phase: 'beta' });
      await store1.flush();
      await store1.saveSnapshot();

      // Remove version to simulate old format
      const snapshotPath = path.join(dir, 'event-snapshot.json');
      const raw = await fs.readFile(snapshotPath, 'utf-8');
      const snap = JSON.parse(raw);
      delete snap.version;
      await fs.writeFile(snapshotPath, JSON.stringify(snap, null, 2), 'utf-8');

      // Load — should discard snapshot and replay ALL events from JSONL
      const store2 = await EventStore.load(dir);

      expect(store2.getProjection().taskPrompt).toBe('full replay');
      expect(store2.getProjection().currentPhaseId).toBe('beta');
      expect(store2.getProjection().completedPhaseIds).toEqual(['alpha']);
      expect(store2.getProjection().seq).toBe(4);
    });
  });

  // ── load from NDJSON ──────────────────────────────────────────────

  describe('load from NDJSON', () => {
    it('replays events.jsonl when no snapshot exists', async () => {
      // Manually write an events.jsonl file
      const events = [
        {
          seq: 1,
          type: 'workflow_started',
          data: { taskPrompt: 'from file' },
          metadata: { timestamp: new Date().toISOString() },
        },
        {
          seq: 2,
          type: 'phase_started',
          data: { phase: 'impl' },
          metadata: { timestamp: new Date().toISOString(), phase: 'impl' },
        },
      ];
      const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'events.jsonl'), content, 'utf-8');

      const store = await EventStore.load(dir);
      expect(store.getProjection().taskPrompt).toBe('from file');
      expect(store.getProjection().currentPhaseId).toBe('impl');
      expect(store.getProjection().seq).toBe(2);
    });

    it('handles malformed JSONL lines gracefully', async () => {
      const valid = {
        seq: 1,
        type: 'workflow_started',
        data: { taskPrompt: 'ok' },
        metadata: { timestamp: new Date().toISOString() },
      };
      const content = JSON.stringify(valid) + '\nNOT VALID{\n' + JSON.stringify({ ...valid, seq: 2 }) + '\n';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'events.jsonl'), content, 'utf-8');

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      const store = await EventStore.load(dir);
      expect(store.getProjection().taskPrompt).toBe('ok');
      expect(store.getProjection().seq).toBe(2);
      warnSpy.mockRestore();
    });
  });

  // ── load round-trip ────────────────────────────────────────────────

  describe('load round-trip', () => {
    it('full round-trip: append → save → load → verify projection', async () => {
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'Build feature X' });
      store1.append('phase_started', { phase: 'scouting' });
      store1.append('phase_completed', { phase: 'scouting', durationMs: 500 });
      store1.append('phase_started', { phase: 'implementing' });
      await store1.saveSnapshot();

      const store2 = await EventStore.load(dir);
      const proj = store2.getProjection();
      expect(proj.taskPrompt).toBe('Build feature X');
      expect(proj.currentPhaseId).toBe('implementing');
      expect(proj.completedPhaseIds).toEqual(['scouting']);
      expect(proj.seq).toBe(4);
    });

    it('subscribers work after load', async () => {
      const store1 = new EventStore(dir);
      store1.append('workflow_started', { taskPrompt: 'init' });
      await store1.saveSnapshot();

      const store2 = await EventStore.load(dir);
      let notified = 0;
      store2.subscribe(() => {
        notified++;
      });
      store2.append('phase_started', { phase: 'scouting' });
      expect(notified).toBe(1);
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────

  describe('dispose', () => {
    it('clears all subscribers', () => {
      const store = new EventStore(dir);
      let calls = 0;
      store.subscribe(() => {
        calls++;
      });
      store.append('workflow_started', { taskPrompt: 'a' });
      expect(calls).toBe(1);

      store.dispose();
      // The subscriber set is emptied so callbacks do not leak past teardown.
      expect((store as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);

      // A post-dispose append is a no-op, so the cleared subscriber is never
      // invoked again.
      store.append('workflow_started', { taskPrompt: 'b' });
      expect(calls).toBe(1);
    });

    it('append() after dispose returns a synthetic record with the incremented seq', () => {
      const store = new EventStore(dir);
      const r1 = store.append('workflow_started', { taskPrompt: 'pre' });
      expect(r1.seq).toBe(1);

      store.dispose();

      // The returned record still carries the next seq and the passed
      // type/data, but it is synthetic — the store does nothing else with it.
      const r2 = store.append('phase_started', { phase: 'ignored' });
      expect(r2.seq).toBe(2);
      expect(r2.type).toBe('phase_started');
      expect(r2.data.phase).toBe('ignored');
      expect(r2.metadata.timestamp).toBeDefined();
      expect(new Date(r2.metadata.timestamp).toISOString()).toBe(r2.metadata.timestamp);

      // A third append keeps incrementing seq without doing any real work.
      const r3 = store.append('phase_completed', { phase: 'ignored', durationMs: 1 });
      expect(r3.seq).toBe(3);
    });

    it('append() after dispose does not evolve the projection', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'frozen' });
      const before = store.getProjection();
      expect(before.taskPrompt).toBe('frozen');
      expect(before.seq).toBe(1);

      store.dispose();
      store.append('phase_started', { phase: 'should-not-apply' });

      const after = store.getProjection();
      // Projection STATE is unchanged — no evolve ran on the disposed append.
      expect(after.taskPrompt).toBe('frozen');
      expect(after.currentPhaseId).toBe(before.currentPhaseId);
      expect(after.status).toBe(before.status);
    });

    it('append() after dispose does not write to disk', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'persisted' });
      await store.flush();

      store.dispose();
      store.append('workflow_started', { taskPrompt: 'dropped' });
      store.append('workflow_started', { taskPrompt: 'dropped2' });
      // Give any (incorrectly) scheduled write a chance to land.
      await new Promise<void>((r) => queueMicrotask(r));
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).data.taskPrompt).toBe('persisted');
    });

    it('flush() after dispose resolves without error and writes nothing', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'one' });
      await store.flush();

      store.dispose();
      // No pending writes (append is a no-op); flush returns early cleanly.
      await expect(store.flush()).resolves.toBeUndefined();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      expect(raw.trim().split('\n')).toHaveLength(1);
    });

    it('saveSnapshot() after dispose returns early and writes no snapshot file', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'pre' });
      store.dispose();

      await store.saveSnapshot();

      // Early return → no snapshot file created.
      await expect(fs.readFile(path.join(dir, 'event-snapshot.json'), 'utf-8')).rejects.toThrow();
    });

    it('saveSnapshot() works before dispose but does not overwrite after dispose', async () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'snap' });
      await store.saveSnapshot();
      const snapshotPath = path.join(dir, 'event-snapshot.json');
      const before = await fs.readFile(snapshotPath, 'utf-8');

      store.dispose();
      // A disposed append increments the internal seq counter, so a real
      // saveSnapshot would change the persisted `seq`/`timestamp`. Verifying
      // byte-equality proves the post-dispose saveSnapshot was a no-op.
      store.append('workflow_started', { taskPrompt: 'ignored' });
      await store.saveSnapshot();

      const after = await fs.readFile(snapshotPath, 'utf-8');
      expect(after).toBe(before);
    });

    it('append() after dispose does not add synthetic records to the ring buffer', () => {
      const store = new EventStore(dir);
      store.append('workflow_started', { taskPrompt: 'kept' }); // seq 1 — in buffer
      expect(store.getEventsSince(0)).toHaveLength(1);

      store.dispose();
      // Synthetic appends are no-ops: they must NOT be pushed into the ring
      // buffer, otherwise getEventsSince would surface records that were
      // never evolved or persisted.
      store.append('phase_started', { phase: 'ghost' }); // seq 2 — synthetic
      store.append('phase_completed', { phase: 'ghost', durationMs: 1 }); // seq 3

      const events = store.getEventsSince(0);
      expect(events).toHaveLength(1);
      expect(events[0].seq).toBe(1);
      expect(events[0].type).toBe('workflow_started');
    });

    it('flush() after dispose does not throw even when writes were still pending', async () => {
      const store = new EventStore(dir);
      // Schedule a write but do NOT await it before disposing — simulates a
      // store abandoned mid-drain (e.g. a reaped run handle). dispose() must
      // not leave the writeQueue in a state that makes a subsequent flush()
      // reject.
      store.append('workflow_started', { taskPrompt: 'pending' });
      store.dispose();

      await expect(store.flush()).resolves.toBeUndefined();
    });

    it('dispose() is idempotent', () => {
      const store = new EventStore(dir);
      expect(() => {
        store.dispose();
        store.dispose();
        store.dispose();
      }).not.toThrow();
    });

    it('does not affect an independent store instance', () => {
      const a = new EventStore(dir);
      const b = new EventStore(dir);
      a.dispose();

      // Disposing `a` must not silence `b`.
      let notified = 0;
      b.subscribe(() => {
        notified++;
      });
      b.append('workflow_started', { taskPrompt: 'still alive' });
      expect(notified).toBe(1);
      expect(b.getProjection().taskPrompt).toBe('still alive');
    });
  });

  // ── writeQueue depth bounding ─────────────────────────────────────

  describe('writeQueue depth bounding', () => {
    it('persists every event in order and resolves flush across the depth threshold', async () => {
      const store = new EventStore(dir);
      // Trigger exactly one drain per microtask tick so each append chains a
      // fresh link onto writeQueue. Cross the documented ~1000 threshold so
      // the depth-reset code path is exercised without losing or reordering
      // any records.
      const N = 1050;
      for (let i = 0; i < N; i++) {
        store.append('sidebar_updated', { title: `t${i}` });
        // Yield a microtask so the scheduled drainPending fires (chaining
        // another writeQueue link) before the next append coalesces into it.
        await Promise.resolve();
      }

      // flush() must settle the entire — possibly reset — chain.
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        const rec = JSON.parse(lines[i]);
        expect(rec.seq).toBe(i + 1);
        expect(rec.data.title).toBe(`t${i}`);
      }
    });

    it('flush() remains durable after the depth threshold has been crossed', async () => {
      const store = new EventStore(dir);
      // Build chain depth past the threshold.
      for (let i = 0; i < 1050; i++) {
        store.append('sidebar_updated', { title: `burst-${i}` });
        await Promise.resolve();
      }
      await store.flush();

      // A normal coalesced append + flush AFTER the reset must still persist.
      store.append('workflow_started', { taskPrompt: 'after reset' });
      store.append('phase_started', { phase: 'p' });
      await store.flush();

      const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      const lastTwo = lines.slice(-2);
      expect(JSON.parse(lastTwo[0]).type).toBe('workflow_started');
      expect(JSON.parse(lastTwo[1]).type).toBe('phase_started');
      expect(JSON.parse(lastTwo[1]).seq).toBe(1052);
    });
  });

  // ── writeQueue backpressure guard (persistent write failures) ──────
  //
  // Under sustained write pressure with persistent disk failures (e.g. disk
  // full), the writeQueue promise chain must not grow unboundedly. After a
  // threshold of consecutive failures, the store stops attempting disk writes
  // while keeping the in-memory projection / ring buffer live. A successful
  // write after a transient failure resets the counter so writes resume.

  describe('writeQueue backpressure guard', () => {
    // Each test spies on fs.appendFile to force / observe disk-write outcomes.
    // mockRestore() runs in a `finally` so a failing (RED) assertion cannot leak
    // the spy into a sibling test and corrupt its call counts.

    it('stops calling appendFile after 10 consecutive write failures', async () => {
      const store = new EventStore(dir);
      // Force every disk append to fail persistently (e.g. disk full). mkdir
      // still succeeds (the temp dir exists) so ensureDir is satisfied and the
      // failure lands on appendFile itself.
      const appendSpy = spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC: no space left on device'));
      try {
        // Each append + flush drives exactly one drain → one appendFile attempt.
        for (let i = 0; i < 10; i++) {
          store.append('sidebar_updated', { title: `fail-${i}` });
          await store.flush();
        }
        // 10 consecutive failures → counter reaches the threshold.
        expect(appendSpy).toHaveBeenCalledTimes(10);

        // Further appends must NOT trigger appendFile — the guard short-circuits
        // the write attempt to prevent unbounded promise-chain growth.
        store.append('sidebar_updated', { title: 'guarded-1' });
        await store.flush();
        store.append('sidebar_updated', { title: 'guarded-2' });
        await store.flush();

        expect(appendSpy).toHaveBeenCalledTimes(10); // no new attempts
      } finally {
        appendSpy.mockRestore();
      }
    });

    it('a successful write resets the failure counter so writes resume', async () => {
      const store = new EventStore(dir);
      let shouldFail = true;
      const appendSpy = spyOn(fs, 'appendFile').mockImplementation(
        () => (shouldFail ? Promise.reject(new Error('transient')) : Promise.resolve()) as Promise<void>,
      );
      try {
        // 9 failures — below the threshold, so writes are still attempted.
        for (let i = 0; i < 9; i++) {
          store.append('sidebar_updated', { title: `f-${i}` });
          await store.flush();
        }
        expect(appendSpy).toHaveBeenCalledTimes(9);

        // A successful write resets the consecutive-failure counter to 0.
        shouldFail = false;
        store.append('sidebar_updated', { title: 'recover' });
        await store.flush();
        expect(appendSpy).toHaveBeenCalledTimes(10);

        // After the reset, another burst of sub-threshold failures must STILL be
        // attempted (the counter was cleared, so the guard has not tripped).
        shouldFail = true;
        for (let i = 0; i < 9; i++) {
          store.append('sidebar_updated', { title: `f2-${i}` });
          await store.flush();
        }
        expect(appendSpy).toHaveBeenCalledTimes(19); // all attempted, none short-circuited
      } finally {
        appendSpy.mockRestore();
      }
    });

    it('keeps the in-memory projection and ring buffer updating while writes fail', async () => {
      const store = new EventStore(dir);
      const appendSpy = spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      try {
        // Append well past the failure threshold — the guard trips, but the
        // in-memory state must keep evolving for every event.
        for (let i = 0; i < 15; i++) {
          store.append('sidebar_updated', { title: `t${i}` });
          await store.flush();
        }

        const proj = store.getProjection();
        expect(proj.seq).toBe(15);
        expect(proj.sidebar.title).toBe('t14');

        // Ring buffer retains all events despite zero successful disk writes.
        const events = store.getEventsSince(0);
        expect(events).toHaveLength(15);
        expect(events[14].seq).toBe(15);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it('flush() resolves cleanly under sustained persistent write failures', async () => {
      const store = new EventStore(dir);
      const appendSpy = spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      try {
        for (let i = 0; i < 20; i++) {
          store.append('sidebar_updated', { title: `t${i}` });
          // flush() must never reject — the writeQueue swallows write errors.
          await expect(store.flush()).resolves.toBeUndefined();
        }
      } finally {
        appendSpy.mockRestore();
      }
    });

    it('subscribers keep being notified while writes fail', async () => {
      const store = new EventStore(dir);
      const appendSpy = spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      try {
        let notifications = 0;
        store.subscribe(() => {
          notifications++;
        });

        for (let i = 0; i < 12; i++) {
          store.append('sidebar_updated', { title: `t${i}` });
          await store.flush();
        }
        // Every append fires the subscriber synchronously, independent of disk.
        expect(notifications).toBe(12);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it('does not stop writes when failures are intermittent (below threshold between successes)', async () => {
      const store = new EventStore(dir);
      // Alternating fail / succeed — the counter never reaches the threshold
      // because each success resets it, so every write is attempted.
      let shouldFail = true;
      const appendSpy = spyOn(fs, 'appendFile').mockImplementation(
        () => (shouldFail ? Promise.reject(new Error('flaky')) : Promise.resolve()) as Promise<void>,
      );
      try {
        for (let i = 0; i < 30; i++) {
          store.append('sidebar_updated', { title: `t${i}` });
          await store.flush();
          shouldFail = !shouldFail;
        }
        expect(appendSpy).toHaveBeenCalledTimes(30); // none short-circuited
      } finally {
        appendSpy.mockRestore();
      }
    });
  });
});
