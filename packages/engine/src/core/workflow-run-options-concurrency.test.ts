// WorkflowRunOptions — modelConcurrency and defaultMaxConcurrentSessions were
// removed in C2. This file pins that neither property exists on the type.

import type { WorkflowRunOptions } from './types.js';

type AssertTrue<T extends true> = T;
type HasField<K extends string> = K extends keyof WorkflowRunOptions ? true : false;

type _NoModelConcurrency = AssertTrue<HasField<'modelConcurrency'> extends true ? false : true>;
type _NoDefaultMaxConcurrentSessions = AssertTrue<HasField<'defaultMaxConcurrentSessions'> extends true ? false : true>;

export type { _NoDefaultMaxConcurrentSessions, _NoModelConcurrency };
