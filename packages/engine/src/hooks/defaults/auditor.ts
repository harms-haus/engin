// ─── Default implementations of the audit observe hooks ────────────────────
//
// `createDefaultAuditor(auditLog)` returns the DEFAULT implementations of the
// `onStructuredOutput` and `onDecision` observe hooks (see hooks/types.ts).
// Each translates its hook args into the matching `AuditEvent` variant (see
// core/types.ts) and appends it to the durable `AuditLog`.
//
// `AuditLog.append` takes `Omit<AuditEvent, 'timestamp'>` and stamps the
// timestamp ITSELF, so the hook need not (and must not, per the type) supply
// one — the appended record always ends up with a real timestamp regardless.
//
// The `structured_output` AuditEvent variant carries ONLY { type, agentId,
// output, taskId?, timestamp } (no phaseId/stepIndex — those exist on the hook
// args but are intentionally not persisted to the audit event). The `decision`
// variant carries { type, agentId, decision, reasoning, taskId?, timestamp }.

import type { AuditLog } from '../../tracking/audit-log.js';
import type { ObserveHook, OnDecisionArgs, OnStructuredOutputArgs } from '../types.js';

/**
 * Builds the default auditor: an object exposing the `onStructuredOutput` and
 * `onDecision` observe hooks, each appending the corresponding `AuditEvent`
 * variant to the supplied `auditLog`.
 *
 * Returns a plain object (not a class) keyed by hook name, so it can be spread
 * directly into a `WorkflowHooks` registration.
 */
export function createDefaultAuditor(auditLog: AuditLog): {
  onStructuredOutput: ObserveHook<OnStructuredOutputArgs>;
  onDecision: ObserveHook<OnDecisionArgs>;
} {
  return {
    onStructuredOutput: async (args) => {
      await auditLog.append({
        type: 'structured_output',
        agentId: args.agentId,
        output: args.output,
        taskId: args.taskId,
      });
    },
    onDecision: async (args) => {
      await auditLog.append({
        type: 'decision',
        agentId: args.agentId,
        decision: args.decision,
        reasoning: args.reasoning,
        taskId: args.taskId,
      });
    },
  };
}
