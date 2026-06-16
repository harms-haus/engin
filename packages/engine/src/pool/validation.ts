/** Reject values that could escape the session directory via path traversal. */
export function assertSafeName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" contains unsafe characters`);
  }
}
