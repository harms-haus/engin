// ─── Default implementations of the prompt-context hooks ───────────────────
//
// `defaultCollectContext` and `defaultBeforeStepPrompt` are the DEFAULT
// implementations of the `collectContext` (all-run) and `beforeStepPrompt`
// (pipeline) hooks (see hooks/types.ts). They reproduce — EXACTLY — the
// file-inlining + prompt-assembly behavior in
// `pool/prompt-builder.ts::buildPrompt`, so existing workflows are unchanged
// when the engine switches to invoking the hooks.
//
// The single behavioral difference from legacy `buildPrompt(task, step, cwd)`
// is the TWO-CWD world: files resolve against the per-task WORKTREE cwd
// (`args.worktreeCwd ?? args.cwd`), NOT the run cwd. This reflects
// post-worktree execution where each task runs in its own checkout.
//
// Both defaults delegate the per-file section formatting to the shared
// `pool/file-context.ts::collectFileSection` helper — the single source of
// truth shared with `buildPrompt` — guaranteeing byte-identical file sections.

import { collectFileSection } from '../../pool/file-context.js';
import type { BeforeStepPromptArgs, CollectContextArgs, ContextBlock, HookContext, PipelineHook } from '../types.js';

/**
 * Resolve the cwd used for file inlining: the per-task worktree cwd when
 * present, else the run cwd. This is the two-cwd resolution rule.
 */
function resolveFileCwd(args: { cwd: string; worktreeCwd?: string }): string {
  return args.worktreeCwd ?? args.cwd;
}

/**
 * DEFAULT `collectContext` (all-run) hook.
 *
 * Reads `task.files` (if any). For each file: skip binary extensions, resolve
 * the path against `args.worktreeCwd ?? args.cwd`, read its contents (capped at
 * 10KB with a truncation marker), detect the language from the extension, and
 * inline it as a fenced code block — exactly as `buildPrompt` does.
 *
 * Returns a single {@link ContextBlock} whose `content` is every inlined file
 * section concatenated in listed order (and whose `label` is the filepath, or
 * the comma-joined filepaths when multiple). Returns `undefined` (abstains)
 * when `task.files` is empty or every file is skipped (binary / unreadable) —
 * matching `buildPrompt`, which omits the section entirely in that case.
 *
 * NOTE on the signature: this is the default `collectContext` hook (an
 * all-run hook contributing `ContextBlock`s). It is typed with explicit
 * parameter types rather than the `AllRunHook<ContextBlock, CollectContextArgs>`
 * alias because the alias's return type (`ContextBlock | Promise<ContextBlock>`)
 * does not model abstention, while this default MUST return `undefined` when
 * there is nothing to contribute (mirroring `buildPrompt` omitting the file
 * section). The registry's `invokeAllRun` and `CONTEXT_BLOCK_REDUCER` both
 * tolerate `undefined` contributions at runtime.
 */
export async function defaultCollectContext(
  args: CollectContextArgs,
  _ctx: HookContext,
): Promise<ContextBlock | undefined> {
  if (!args.task.files?.length) return undefined;
  const cwd = resolveFileCwd(args);

  const sections: string[] = [];
  const labels: string[] = [];
  for (const fp of args.task.files) {
    const section = await collectFileSection(fp, cwd);
    if (section !== null) {
      sections.push(section);
      labels.push(fp);
    }
  }

  if (sections.length === 0) return undefined;
  return { label: labels.join(', '), content: sections.join('\n') };
}

/**
 * DEFAULT `beforeStepPrompt` (pipeline) hook.
 *
 * Reproduces `buildPrompt`'s prompt assembly — task title header, step name
 * header, the inlined file context (via {@link defaultCollectContext}), the
 * prompt body, and the review-feedback history — while honoring the PIPELINE
 * contract: the incoming `value` is used as the prompt body (NOT `task.prompt`),
 * so a prior subscriber's transform flows through unchanged.
 *
 * When `value === task.prompt` and `worktreeCwd` is absent, the output is
 * byte-identical to `buildPrompt(task, step, cwd)`.
 */
export const defaultBeforeStepPrompt: PipelineHook<string, BeforeStepPromptArgs> = async (value, args, ctx) => {
  const parts: string[] = [];

  parts.push(`## Task: ${args.task.title}`);
  parts.push(`## Step: ${args.step.name}`);
  parts.push('');

  // ─── File context (delegates to defaultCollectContext for two-cwd resolution)
  const block = await defaultCollectContext(
    {
      task: args.task,
      step: args.step,
      cwd: args.cwd,
      ...(args.worktreeCwd !== undefined && { worktreeCwd: args.worktreeCwd }),
    },
    ctx,
  );
  if (block) parts.push(block.content);

  // ─── Prompt body (the pipeline `value`, NOT task.prompt)
  parts.push(value);

  // ─── Review feedback history (appended verbatim from task.reviewFeedback)
  if (args.task.reviewFeedback && args.task.reviewFeedback.length > 0) {
    parts.push('');
    parts.push('## Review Feedback History (please address all items)');
    args.task.reviewFeedback.forEach((fb, i) => {
      parts.push(`Attempt ${i + 1}: ${fb}`);
    });
  }

  return parts.join('\n');
};
