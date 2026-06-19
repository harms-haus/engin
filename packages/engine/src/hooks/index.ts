// types.ts and registry.ts BOTH export `HookRegistry` (types.ts as an interface,
// registry.ts as a class). To avoid the TS2308 ambiguity error we re-export
// with explicit names from each.
export * from './compose.js';
export { HOOK_DECLARATIONS, getHookDeclaration } from './declarations.js';
export type { HookDeclaration } from './declarations.js';
export * from './defaults/index.js';
export * from './reducers.js';
export { HookRegistry, createHookRegistry } from './registry.js';
export type {
  AllRunHook,
  CompositionRule,
  FirstWinsHook,
  HookContext,
  HookDefinition,
  HookProvider,
  ObserveHook,
  PipelineHook,
  WorkflowHooks,
} from './types.js';
