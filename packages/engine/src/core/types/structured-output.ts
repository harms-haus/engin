export interface StructuredOutputOptions {
  maxRetries: number;
  retryPrompt?: string;
  /** Optional per-prompt timeout in milliseconds. When a positive finite number,
   *  each `harness.prompt()` call is raced against a timeout. On expiry an
   *  error is thrown. Unset/0/NaN/negative → no timeout. */
  stepTimeoutMs?: number;
}
