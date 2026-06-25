import { Effect } from "effect";
import { IssueRepoMismatch } from "../errors.ts";
import { currentRepoSlug } from "../issues.ts";

export interface PrRef {
  readonly number: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly ghArg: string;
}

const isUrlRef = (ref: PrRef): ref is PrRef & { owner: string; repo: string } =>
  ref.owner !== undefined && ref.repo !== undefined;

const PR_URL = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

export const parsePrArg = (token: string): PrRef | undefined => {
  if (/^\d+$/.test(token)) {
    return { number: Number(token), ghArg: token };
  }
  const match = PR_URL.exec(token);
  if (match === null) return undefined;
  const [, owner, repo, n] = match;
  return { number: Number(n), owner, repo, ghArg: `https://github.com/${owner}/${repo}/pull/${n}` };
};

export const validatePrRef = Effect.fn("homestead/validate-pr-ref")(function* (ref: PrRef) {
  if (!isUrlRef(ref)) return;

  const here = (yield* currentRepoSlug()).toLowerCase();
  if (`${ref.owner}/${ref.repo}`.toLowerCase() !== here) {
    return yield* new IssueRepoMismatch({
      owner: ref.owner,
      repo: ref.repo,
      here,
    });
  }
});
