export interface AgentLoopResult<T> {
  result: T;
  attempts: number;
  totalTokens: { input: number; output: number };
}
