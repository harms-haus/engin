import type { AgentProfile } from './profiles.js';

export type AuditEvent =
  | {
      type: 'agent_start';
      agentId: string;
      profile: AgentProfile;
      taskId?: string;
      timestamp: string;
      phaseId?: string;
    }
  | { type: 'agent_end'; agentId: string; result: unknown; taskId?: string; timestamp: string; phaseId?: string }
  | { type: 'decision'; agentId: string; decision: string; reasoning: string; taskId?: string; timestamp: string }
  | { type: 'structured_output'; agentId: string; output: unknown; taskId?: string; timestamp: string }
  | { type: 'error'; agentId: string; error: string; taskId?: string; timestamp: string }
  // ── Scheduler orchestration traces ─────────────────────────────────────
  // High-volume diagnostic records appended by SessionScheduler so that
  // scheduling decisions (why a session started / parked / was skipped) are
  // durable and inspectable in the run's audit log. One `scheduler_drain`
  // event is emitted per drain pass with the full candidate evaluation.
  | {
      type: 'scheduler_drain';
      phaseId: string;
      trigger: 'init' | 'release' | 'completion' | 'abort';
      gate: {
        totalAvailable: number;
        totalCap: number;
        models: { key: string; available: number; cap: number | null }[];
      };
      /** Per-candidate outcome for this drain pass, in evaluation order. */
      candidates: {
        taskId: string;
        status: string;
        dependents: number;
        started: { specId: string; profile: string }[];
        parkedSpecs: { specId: string; profile: string; reason: string }[];
        skipped: boolean;
        skipReason?: string;
      }[];
      timestamp: string;
    }
  | {
      type: 'scheduler_session_settle';
      phaseId: string;
      taskId: string;
      specId: string;
      profile: string;
      success: boolean;
      error?: string;
      batchComplete: boolean;
      advanced: boolean;
      timestamp: string;
    };
