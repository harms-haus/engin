// ─── Validation-Retry (file-based output) ────────────────────────────────────
//
// Mirrors `promptForStructured`'s retry loop, but reads validation state from
// the filesystem (via a caller-supplied `validateOutput` gate) instead of the
// response text. Used by step/task runners that re-prompt within the SAME
// session when a file-based output fails validation.

import { buildValidationRetryPrompt } from '../pool/prompt-builder.js';

/** Minimal session interface — just enough to drive the retry loop. */
interface RetryableSession {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
}

/**
 * Run a prompt against `session`, validating the agent's file-based output
 * after each turn and re-prompting within the SAME session until it passes or
 * attempts are exhausted.
 *
 * Behaviour:
 * - On the first attempt (or whenever no error is recorded yet), the original
 *   `prompt` is sent verbatim.
 * - On subsequent attempts after a validation failure, the prompt is rebuilt
 *   via {@link buildValidationRetryPrompt} to append the error block.
 * - `validateOutput` is called after each turn; return `{ error }` to retry or
 *   `undefined` / `{}` to accept.
 * - After `maxAttempts` (default 3) consecutive failures, throws an
 *   `Agent output failed validation after N attempts: <error>` error — matching
 *   the message previously inlined in `oneStepTask` / `multiStepTask`.
 *
 * @returns the session's last assistant text on success.
 */
export async function runWithValidationRetry(
  session: RetryableSession,
  prompt: string,
  validateOutput: () => Promise<{ error?: string } | undefined> | ({ error?: string } | undefined),
  maxAttempts = 3,
): Promise<string> {
  let validationError: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const turnPrompt =
      attempt === 0 || validationError === undefined ? prompt : buildValidationRetryPrompt(prompt, validationError);
    await session.prompt(turnPrompt);
    const gate = await validateOutput();
    validationError = gate?.error;
    if (!validationError) break;
  }
  if (validationError) {
    throw new Error(`Agent output failed validation after ${maxAttempts} attempts: ${validationError}`);
  }
  return session.getLastAssistantText() ?? '';
}
