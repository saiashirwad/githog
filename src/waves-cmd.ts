import { Console, Effect, Schema } from "effect";
import { ExternalCommandError } from "./errors.ts";
import type { IssueRef } from "./issues.ts";
import { capture } from "./process.ts";
import { parseWaveMetadata, planWaves, renderHuman, renderJson, type ParsedIssue } from "./waves.ts";

// IO shell for `homestead plan`. The scheduling logic is pure (src/waves.ts);
// this file's only jobs are fetching issue bodies via `gh` and rendering.

const IssueBody = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.String,
});

const loadIssue = Effect.fn("homestead/plan-load-issue")(function* (ref: IssueRef) {
  const json = yield* capture("gh", ["issue", "view", ref.ghArg, "--json", "number,title,body"]);
  const item = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(IssueBody))(json).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ExternalCommandError({ command: "gh issue view", detail: error.message }),
    ),
  );
  const meta = parseWaveMetadata(item.body);
  return {
    number: item.number,
    title: item.title,
    touches: meta.touches,
    dependsOn: meta.dependsOn,
  } satisfies ParsedIssue;
});

export const loadIssuesForPlan = Effect.fn("homestead/load-issues-for-plan")(function* (
  refs: ReadonlyArray<IssueRef>,
) {
  return yield* Effect.forEach(refs, loadIssue);
});

// Fetch → plan → render. planWaves throws WavePlanError (pure code), so we wrap
// it in Effect.try and surface it through the typed error channel; the CLI
// catches WavePlanError and prints a clean line + exits non-zero.
export const runPlan = Effect.fn("homestead/run-plan")(function* (
  refs: ReadonlyArray<IssueRef>,
  json: boolean,
) {
  const issues = yield* loadIssuesForPlan(refs);
  const schedule = yield* Effect.try({
    try: () => planWaves(issues),
    catch: (e) => e as import("./waves.ts").WavePlanError,
  });
  yield* Console.log(json ? renderJson(schedule) : renderHuman(schedule));
});
