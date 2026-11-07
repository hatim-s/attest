import type { AgentRequest } from '@attest/contracts';
import type { InvocationResult } from '@attest/executor';
import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

type ProcessSession = {
  invoke(request: AgentRequest, signal?: AbortSignal): Effect.Effect<InvocationResult, Error>;
  close(): Effect.Effect<void, Error>;
};

/** Acquires the executor session in the caller's run scope, retained through explicit close. */
const openProcessSession = (acquire: Effect.Effect<ProcessSession, Error, Scope.Scope>) => acquire;

export { openProcessSession };
