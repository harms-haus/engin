import { mock } from 'bun:test';

/**
 * Creates a mock session object for testing.
 * Returns { session, sessionId } where session has mock prompt, getLastAssistantText,
 * subscribe, and dispose methods.
 *
 * Default textFn returns 'ok'.
 */
export function makeMockSession(textFn: (promptText: string) => string | undefined = () => 'ok') {
  let lastText: string | undefined;
  const session = {
    prompt: mock(async (text: string) => {
      lastText = textFn(text);
    }),
    getLastAssistantText: mock(() => lastText),
    sessionId: 'test-session',
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
  };
  return { session, sessionId: 'test-session' };
}
