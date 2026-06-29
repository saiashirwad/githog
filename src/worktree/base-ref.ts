import { Effect } from "effect";
import { UsageError } from "../errors.ts";
import { Git } from "../git/service.ts";

export const branchFromOriginHead = (symbolicRef: string): string =>
  symbolicRef.startsWith("origin/") ? symbolicRef.slice("origin/".length) : symbolicRef;

// Thin delegator kept so existing callers (land, teardown, plan, pr/branch) stay
// put this PR; later PRs switch them to git.refExists directly and this is removed.
export const refExists = (primaryRoot: string, ref: string) =>
  Git.pipe(Effect.flatMap((git) => git.refExists(primaryRoot, ref)));

export const resolveDefaultBaseRef = Effect.fn("homestead/resolve-default-base-ref")(function* (
  primaryRoot: string,
) {
  const git = yield* Git;
  const origin = yield* git.symbolicRef(primaryRoot, "refs/remotes/origin/HEAD");
  if (origin !== undefined) return branchFromOriginHead(origin);

  for (const branch of ["main", "master"] as const) {
    if (yield* git.refExists(primaryRoot, `refs/heads/${branch}`)) return branch;
  }

  return yield* new UsageError({
    message:
      "[homestead] could not determine default branch (no origin/HEAD, main, or master) — pass --from explicitly",
  });
});
