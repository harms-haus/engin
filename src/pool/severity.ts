// ─── Severity Types & Helpers ──────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export function isFailingSeverity(severity: Severity | string): boolean {
  return severity === 'critical' || severity === 'high';
}

export function extractSeverity(output: unknown): string {
  if (typeof output === 'object' && output !== null && 'severity' in output) {
    const sev = (output as Record<string, unknown>).severity;
    return typeof sev === 'string' ? sev : 'medium';
  }
  return 'medium';
}
