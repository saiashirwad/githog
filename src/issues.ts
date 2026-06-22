import { Effect, Schema } from "effect";
import { capture } from "./process.ts";
import type { WorkItem } from "./types.ts";

// A work-item argument, already parsed from the command line: either a bare issue
// number (resolved against the current repo) or a full GitHub issue URL (which
// also pins owner/repo so we can guard it against the repo you're standing in).
export interface IssueRef {
  readonly number: number;
  readonly owner?: string | undefined;
  readonly repo?: string | undefined;
  readonly ghArg: string; // what to hand `gh issue view`
}

// Accept `2` or `[https://]github.com/<owner>/<repo>/issues/<n>[...]`.
const ISSUE_URL = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;

export const parseIssueArg = (token: string): IssueRef | undefined => {
  if (/^\d+$/.test(token)) {
    return { number: Number(token), ghArg: token };
  }
  const match = ISSUE_URL.exec(token);
  if (match === null) return undefined;
  const [, owner, repo, n] = match;
  // Normalize to a canonical URL so gh accepts it regardless of how it was typed.
  return { number: Number(n), owner, repo, ghArg: `https://github.com/${owner}/${repo}/issues/${n}` };
};

// Boundary decodes: never assert gh's JSON, decode it (v4: parseJson became
// Schema.fromJsonString). The IssueView shape IS WorkItem.
const IssueView = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
});
const decodeIssueView = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueView));

const RepoView = Schema.Struct({ nameWithOwner: Schema.String });
const decodeRepoView = Schema.decodeUnknownEffect(Schema.fromJsonString(RepoView));

// "owner/repo" of the repo the current directory belongs to (per gh). Used to
// reject a URL that points at a different repo than the one you're standing in.
export const currentRepoSlug = Effect.fn("homestead/current-repo")(function* () {
  const json = yield* capture("gh", ["repo", "view", "--json", "nameWithOwner"]);
  const view = yield* decodeRepoView(json).pipe(Effect.orDie);
  return view.nameWithOwner;
});

// Resolve an IssueRef to a WorkItem via the gh CLI (gh takes a number against the
// current repo, or a full URL). A malformed response is a defect.
export const resolveIssue = Effect.fn("homestead/resolve-issue")(function* (ref: IssueRef) {
  const json = yield* capture("gh", ["issue", "view", ref.ghArg, "--json", "number,url,title"]);
  const item: WorkItem = yield* decodeIssueView(json).pipe(Effect.orDie);
  return item;
});
