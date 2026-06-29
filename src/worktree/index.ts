import { Console, Effect } from "effect";
import type { HomesteadConfig, WorktreeOptions } from "../types.ts";
import { makeContext } from "../context.ts";
import {
  makeWorktreeContext,
  printPlan,
  resolvePlan,
  resolveTarget,
  type Target,
} from "./plan.ts";
import { ensureServices, printDone, resolveSetup, runSetup, writeEnv } from "./provision.ts";
import { finalizeReservations, PortAllocator } from "./ports.ts";
import { writeProvisionMarker } from "./marker.ts";
import { normalizeHookResult } from "../hooks.ts";
import type { Repo } from "./repo.ts";

export { resolveRepo } from "./repo.ts";
export type { Repo } from "./repo.ts";

// Drive the provisioning pipeline against a PRE-BUILT Target (not the cwd-based
// resolveTarget). setupWorktree resolves a Target from CLI options then calls
// this; `homestead doctor --fix` builds a Target straight from a sibling
// worktree's git-porcelain entry and calls this to re-run setup over it. The
// pipeline is idempotent (resolvePlan keeps the worktree's existing ports,
// ensureServices no-ops when a service is reachable), so a re-run repairs a
// half-provisioned worktree without churning already-assigned values.
export const provisionTarget = Effect.fn("homestead/provision-target")(function* (
  config: HomesteadConfig,
  repo: Repo,
  target: Target,
  options: { readonly dryRun?: boolean; readonly noSetup?: boolean },
) {
  const { semaphore } = yield* PortAllocator;
  const hasPorts = (config.ports ?? []).length > 0;

  // Layer 1 (in-process): hold one permit across the read-pick-write span
  // (resolvePlan's port pick → writeEnv) so sibling fibers of a single invocation
  // can't both pick the same port. `finalize` ALWAYS runs — success, dry-run, or
  // failure — to clear this branch's cross-process reservation once its `.env`
  // carries the port (or nothing was written); TTL/dead-pid expiry is the
  // backstop if the process dies before finalize.
  const region = Effect.gen(function* () {
    const plan = yield* resolvePlan(repo, target, config);
    yield* printPlan(plan);
    if (options.dryRun === true) {
      yield* Console.log(`\n(dry run — no changes made)`);
      return plan;
    }
    yield* writeEnv(plan);
    return plan;
  });
  const plan = yield* semaphore.withPermit(
    hasPorts
      ? region.pipe(
          Effect.ensuring(finalizeReservations(repo.repoName, target.branch, process.pid).pipe(Effect.ignore)),
        )
      : region,
  );
  if (options.dryRun === true) return plan;

  yield* ensureServices(repo, config);

  // Count the setup steps that ran (0 with --no-setup) for the provision marker —
  // mirrors how runSetup builds its ctx so the count matches what executed.
  const envMap = Object.fromEntries(plan.envEdits);
  const setupCtx = {
    ...makeContext({
      repoName: repo.repoName,
      slug: plan.slug,
      branch: plan.branch,
      worktreeDir: plan.targetDir,
      env: (key) => envMap[key],
    }),
    plan,
  };
  const setupSteps = options.noSetup === true ? 0 : resolveSetup(config.setup, setupCtx).length;
  if (options.noSetup !== true) {
    yield* runSetup(repo, plan, config);
  }

  if (config.afterSetup !== undefined) {
    const ctx = { ...makeWorktreeContext(repo, target, plan.sourceContent), plan };
    yield* normalizeHookResult(config.afterSetup(ctx)).pipe(Effect.orDie);
  }

  // The "provisioning finished" record — written last, after every step
  // succeeded, so doctor can tell a complete worktree from a crashed one.
  yield* writeProvisionMarker(target.targetDir, {
    version: 1,
    completedAt: new Date().toISOString(),
    ports: (config.ports ?? []).map((spec) => spec.key),
    setupSteps,
  });

  yield* printDone(plan);
  return plan;
});

// Provision an isolated worktree from the project's config and return its Plan.
export const setupWorktree = Effect.fn("homestead/setup-worktree")(function* (
  config: HomesteadConfig,
  options: WorktreeOptions,
  repo: Repo,
) {
  const target = yield* resolveTarget(repo, options, config);
  return yield* provisionTarget(config, repo, target, options);
});

export type { Plan, WorktreeOptions } from "../types.ts";
