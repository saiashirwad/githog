import { Effect } from "effect";
import type { HomesteadConfig, HomesteadContext, HomesteadServices } from "./types.ts";

export type TeardownVerb = "kill" | "close" | "complete";

// Lifecycle hooks are authored against the generated, effect-free config types,
// where every hook returns `unknown` — so a consumer can return an Effect, a
// Promise (a plain `async () => {…}` with no `effect` import, which matters for
// configs in repos that can't resolve `effect` at their root), or nothing at
// all. Normalize whatever they return into a runnable Effect.
export const normalizeHookResult = (value: unknown): Effect.Effect<void, never, HomesteadServices> => {
  if (Effect.isEffect(value)) return value as Effect.Effect<void, never, HomesteadServices>;
  if (typeof (value as { then?: unknown } | null | undefined)?.then === "function") {
    return Effect.promise(() => value as Promise<unknown>).pipe(Effect.asVoid);
  }
  return Effect.void;
};

export const runAfterLaunch = (
  hook: HomesteadConfig["afterLaunch"],
  ctx: HomesteadContext,
  paneId: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : normalizeHookResult(hook({ ...ctx, paneId }));

export const runBeforeTeardown = (
  hook: HomesteadConfig["beforeTeardown"],
  ctx: HomesteadContext,
  verb: TeardownVerb,
  tracked: boolean,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : normalizeHookResult(hook({ ...ctx, verb, tracked }));

export const runAfterTeardown = (
  hook: HomesteadConfig["afterTeardown"],
  ctx: HomesteadContext,
  verb: TeardownVerb,
  reviewLabel?: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined
    ? Effect.void
    : normalizeHookResult(hook(reviewLabel === undefined ? { ...ctx, verb } : { ...ctx, verb, reviewLabel }));
