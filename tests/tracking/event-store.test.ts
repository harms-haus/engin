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
});
