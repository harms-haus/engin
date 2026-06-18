// ─── Task Feedback Helpers ───────────────────────────────────────────────────
//
// Cross-layer helper for accumulating review feedback on a task's
// `reviewFeedback` array. Lives at the `core` layer so that consumers in both
// `tracking` and `pool` can depend on it without violating the layering rule
// (pool depends on tracking, never the reverse).

/**
 * Append a feedback entry to the task's reviewFeedback array, initializing if
 * needed. Mutates the task object in place — callers hold a direct reference
 * (see `TaskTracker.claimTasks`'s mutable-reference aliasing contract).
 */
export function appendReviewFeedback(task: { reviewFeedback?: string[] }, feedback: string): void {
  if (!task.reviewFeedback) {
    task.reviewFeedback = [];
  }
  task.reviewFeedback.push(feedback);
}
