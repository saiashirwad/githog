import { Effect } from "effect";
import { Git } from "../git/service.ts";
import type { PrView } from "./resolve.ts";

export type PrCheckout =
  | { readonly kind: "same-repo"; readonly branch: string }
  | { readonly kind: "fork"; readonly branch: string };

export const planPrCheckout = (
  pr: PrView,
  prBranch?: (ctx: { pr: PrView; kind: "fork" | "same-repo" }) => string,
): PrCheckout => {
  const kind = pr.isCrossRepository ? "fork" : "same-repo";
  const fallback = kind === "fork" ? `pr-${pr.number}` : pr.headRefName;
  return { kind, branch: prBranch ? prBranch({ pr, kind }) : fallback };
};

// Make sure a local branch points at the PR head, so setupWorktree can attach a
// worktree to it. Same-repo: fetch the head and create the branch only if it's
// missing (never force-reset — an agent may have unpushed commits on it). Fork:
// force-update a throwaway pr-<n> branch from the pull ref (safe; not pushed to).
export const ensureLocalBranch = Effect.fn("homestead/ensure-pr-branch")(function* (
  primaryRoot: string,
  pr: PrView,
  checkout: PrCheckout,
) {
  const git = yield* Git;

  if (checkout.kind === "fork") {
    yield* git.fetch(primaryRoot, "origin", `+pull/${pr.number}/head:${checkout.branch}`);
    return;
  }

  yield* git.fetch(primaryRoot, "origin", pr.headRefName);
  const exists = yield* git.refExists(primaryRoot, `refs/heads/${checkout.branch}`);
  if (!exists) {
    yield* git.branch.create(primaryRoot, checkout.branch, `origin/${pr.headRefName}`);
  }
});
