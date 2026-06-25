import { Console, Effect } from "effect";
import { UsageError } from "../errors.ts";
import { Herdr } from "../herdr/service.ts";
import { launchAndSeed, toSpec } from "../herdr/launch.ts";
import type { AgentConfig, HomesteadConfig } from "../types.ts";
import { setupWorktree, type Repo } from "../worktree/index.ts";
import { ensureLocalBranch, planPrCheckout } from "./branch.ts";
import { buildPrPrompt } from "./prompt.ts";
import { validatePrRef, type PrRef } from "./ref.ts";
import { resolvePr } from "./resolve.ts";

export interface LaunchPrInput {
  readonly mode: "review" | "work";
  readonly ref: PrRef;
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly agent: AgentConfig;
}

export const launchPr = Effect.fn("homestead/launch-pr")(function* (input: LaunchPrInput) {
  const { mode, ref, config, repo, agent } = input;

  yield* validatePrRef(ref);
  const pr = yield* resolvePr(ref);
  const checkout = planPrCheckout(pr);

  if (mode === "work" && checkout.kind === "fork") {
    return yield* new UsageError({
      message:
        `[homestead] cross-repo PR #${pr.number} can't be continued here. ` +
        `Try: homestead review ${pr.number}`,
    });
  }

  yield* Console.log(
    `\n▸ ${mode === "review" ? "Reviewing" : "Continuing"} PR #${pr.number}: ${pr.title}`,
  );

  yield* ensureLocalBranch(repo.primaryRoot, pr, checkout);

  // setupWorktree attaches a worktree to checkout.branch: resolveTarget sees
  // refs/heads/<branch> exists (we just ensured it) and runs `git worktree add
  // <dir> <branch>` instead of creating a new branch.
  const plan = yield* setupWorktree(config, { create: checkout.branch }, repo);

  const prompt = buildPrPrompt(mode, pr, config);
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, `pr-${pr.number}`);
  yield* launchAndSeed(paneId, toSpec(agent), prompt, { readyTimeoutMs: agent.readyTimeoutMs });

  yield* Console.log(
    `  ✓ PR #${pr.number} ready on \`${checkout.branch}\` in herdr pane ${paneId} — switch in to drive it.\n` +
      `    Tear down with: homestead ${mode === "review" ? "kill" : "close"} ${checkout.branch}`,
  );
});
