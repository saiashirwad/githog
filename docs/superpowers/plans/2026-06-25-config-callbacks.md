# Config Callbacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose homestead's remaining hardcoded strings/behaviors as user-customizable callbacks, behind one unified context object, plus lifecycle hooks and an event reporter.

**Architecture:** Config is decoded through `Schema.Struct` (`src/config-schema.ts`); functions can't decode through schema, so callable fields live in `src/types.ts` as interfaces over the decoded `*Data` types and are re-attached in `src/config.ts` (`toConfigData` strips callbacks → schema decode → `mergeValidatedConfig` re-attaches). Every new callback follows that exact two-layer pattern.

**Tech Stack:** Bun, Effect v4 (`effect@4.0.0-beta.85`), `effect/Schema`, `@effect/platform-bun`. Tests via `bun test`.

## Global Constraints

- **Use Bun, not Node:** `bun test`, `bun install`, `bun run`, `bunx`. Never `npm`/`node`.
- **Effect v4:** Schema is `effect/Schema`; never install `@effect/schema` or `@effect/cli`. Consult the effect-solutions guide before writing Effect code (`effect-solutions list`, then `effect-solutions show <topic>`).
- **Two-layer callback pattern is mandatory:** scalar/data forms go in `config-schema.ts` (and its `*_DATA_FIELDS`/`*_SCALAR_FIELDS` arrays); callable forms go only in `types.ts`; re-attachment goes in `config.ts`. Callbacks never pass through `Schema.String`/`Schema.Array`.
- **Default-equivalence is a hard requirement:** with no overrides, every new callback/event/hook must reproduce today's exact strings, glyphs, label color `1D76DB`, close reason `completed`, and assignee `@me`. Snapshot them.
- **Breaking change is intentional:** unifying the context object changes existing callback signatures. Update the dogfood `homestead.config.ts` and bump the version; document in README/changelog.
- **Hooks/reporters return `Effect.Effect<void, never, HomesteadServices>`** — same as the existing `afterSetup`. No error channel; a hook handles its own failures.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/context.ts` — **new.** The `HomesteadContext` base type + a `makeContext` builder. One responsibility: assemble the context object call sites pass to callbacks.
- `src/types.ts` — modify. Re-express callback interfaces over `HomesteadContext`; add hook/`onEvent`/new-callback fields to `HomesteadConfig`.
- `src/config-schema.ts` — modify. Add scalar forms (`labelColor`) and field-list entries; keep callbacks out.
- `src/config.ts` — modify. `toConfigData`/`mergeValidatedConfig` for every new callback-or-value field.
- `src/tracking.ts` — modify. Widen `TrackingStateSchema`; route comments/labels/assignee/close through callbacks.
- `src/events.ts` — **new.** `HomesteadEvent` union + `defaultReporter` (today's log lines) + `emit` helper.
- `src/teardown.ts`, `src/herdr/agent.ts`, `src/pr/provision.ts`, `src/issue/provision.ts`, `src/worktree/plan.ts` — modify. Emit events instead of `Console.log`; fire hooks; use `surfaceLabel`.
- `src/pr/branch.ts` — modify. `prBranch` callback.
- `src/agent/defaults.ts`, `src/herdr/agent.ts` — modify. Resolve `agent.command` callable form.
- `src/worktree/provision.ts` — modify. Resolve `setup` callable form.
- `homestead.config.ts` — modify. Dogfood the new surface; migrate to new signatures.

---

## Task ordering

Tasks 1–2 are the foundation (context + TrackingState). Tasks 3–6 are the issue-message callbacks (the original ask). Tasks 7–9 are hooks. Tasks 10–12 are the reporter. Tasks 13–18 are field callbacks. Each is independently testable.

---

### Task 1: `HomesteadContext` base type + builder

**Files:**
- Create: `src/context.ts`
- Test: `src/context.test.ts`
- Modify: `src/types.ts` (export `HomesteadContext`)

**Interfaces:**
- Produces: `interface HomesteadContext { repoName: string; slug: string; branch: string; worktreeDir: string; item?: WorkItem; pr?: PrView; env: (key: string) => string | undefined }` and `makeContext(input): HomesteadContext`.

- [ ] **Step 1: Write the failing test**

```ts
// src/context.test.ts
import { expect, test } from "bun:test";
import { makeContext } from "./context.ts";

test("makeContext fills required fields and defaults env to undefined-returning", () => {
  const ctx = makeContext({ repoName: "githog", slug: "feat-x", branch: "feat-x", worktreeDir: "/tmp/wt" });
  expect(ctx.repoName).toBe("githog");
  expect(ctx.worktreeDir).toBe("/tmp/wt");
  expect(ctx.item).toBeUndefined();
  expect(ctx.pr).toBeUndefined();
  expect(ctx.env("ANY")).toBeUndefined();
});

test("makeContext passes through item, pr, and env accessor", () => {
  const env = (k: string) => (k === "PORT" ? "3000" : undefined);
  const item = { number: 7, url: "u", title: "t" } as const;
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", item, env });
  expect(ctx.item).toBe(item);
  expect(ctx.env("PORT")).toBe("3000");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/context.test.ts`
Expected: FAIL — `Cannot find module './context.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/context.ts
import type { PrView } from "./pr/resolve.ts";
import type { WorkItem } from "./work-item.ts";

export interface HomesteadContext {
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly item?: WorkItem;
  readonly pr?: PrView;
  readonly env: (key: string) => string | undefined;
}

export interface MakeContextInput {
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly item?: WorkItem;
  readonly pr?: PrView;
  readonly env?: (key: string) => string | undefined;
}

export const makeContext = (input: MakeContextInput): HomesteadContext => ({
  repoName: input.repoName,
  slug: input.slug,
  branch: input.branch,
  worktreeDir: input.worktreeDir,
  ...(input.item !== undefined ? { item: input.item } : {}),
  ...(input.pr !== undefined ? { pr: input.pr } : {}),
  env: input.env ?? (() => undefined),
});
```

Then in `src/types.ts` add `export type { HomesteadContext } from "./context.ts";`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts src/types.ts
git commit -m "feat(config): add HomesteadContext base + makeContext builder"
```

---

### Task 2: Widen `TrackingState` to persist title + worktreeDir

**Files:**
- Modify: `src/tracking.ts:7-14` (`TrackingStateSchema`), `src/tracking.ts:88-94` (write site)
- Test: `src/tracking.test.ts` (create if absent)

**Interfaces:**
- Produces: `TrackingState` now optionally carries `title?: string` and `worktreeDir?: string`; old state files lacking them still decode (fields optional).
- Consumes: `markStarted` already receives `item` and `worktreeDir` (signature `src/tracking.ts:50-56`).

- [ ] **Step 1: Write the failing test**

```ts
// src/tracking.test.ts
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { TrackingStateSchema } from "./tracking.ts";

test("TrackingState decodes legacy state without title/worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const legacy = decode({ number: 7, url: "u", label: "agent:wip" });
  expect(legacy.number).toBe(7);
  expect(legacy.title).toBeUndefined();
  expect(legacy.worktreeDir).toBeUndefined();
});

test("TrackingState round-trips title + worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const s = decode({ number: 7, url: "u", title: "Fix bug", worktreeDir: "/tmp/wt" });
  expect(s.title).toBe("Fix bug");
  expect(s.worktreeDir).toBe("/tmp/wt");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tracking.test.ts`
Expected: FAIL — `TrackingStateSchema` is not exported / `title` not present.

- [ ] **Step 3: Implement: export schema + add optional fields + persist them**

In `src/tracking.ts` change the schema (line 7) to `export const` and add fields:

```ts
export const TrackingStateSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.optional(Schema.String),
  worktreeDir: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  assigned: Schema.optional(Schema.Boolean),
  commented: Schema.optional(Schema.Boolean),
});
```

In `markStarted`, change the written state object (currently lines 88-94) to always persist `title`/`worktreeDir`:

```ts
  const state: TrackingState = {
    number: item.number,
    url: item.url,
    title: item.title,
    worktreeDir,
    ...(wantLabel ? { label } : {}),
    ...(wantAssign ? { assigned: true } : {}),
    ...(commented ? { commented: true } : {}),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tracking.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts src/tracking.test.ts
git commit -m "feat(tracking): persist title + worktreeDir in tracking state"
```

---

### Task 3: `issues.stopComment` callback

**Files:**
- Modify: `src/types.ts` (`IssuesConfig`), `src/config.ts` (`mergeValidatedConfig`), `src/tracking.ts:109-129` (`markStopped`)
- Test: `src/tracking.test.ts`

**Interfaces:**
- Consumes: widened `TrackingState` (Task 2), `HomesteadContext` (Task 1).
- Produces: `IssuesConfig.stopComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string)`. Default body (when `true`/inherited from a recorded `commented`): `` homestead: agent stopped on `${branch}` (${host}) ``.

**Decision:** the stop comment fires only when start recorded `commented: true` (today's behavior). `stopComment` overrides the *body*; pass `stopComment: false` to suppress. If `stopComment` is undefined, default to the same on/off as `commented` with the default body (preserves current behavior exactly).

- [ ] **Step 1: Write the failing test**

```ts
// add to src/tracking.test.ts
import { resolveStopComment } from "./tracking.ts";

test("resolveStopComment default body matches legacy", () => {
  const body = resolveStopComment(undefined, { branch: "feat-x", host: "mac", worktreeDir: "/w" } as any);
  expect(body).toBe("homestead: agent stopped on `feat-x` (mac)");
});

test("resolveStopComment false suppresses", () => {
  expect(resolveStopComment(false, { branch: "feat-x", host: "mac" } as any)).toBeUndefined();
});

test("resolveStopComment function form wins", () => {
  const body = resolveStopComment((c: any) => `bye ${c.branch}`, { branch: "feat-x", host: "mac" } as any);
  expect(body).toBe("bye feat-x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tracking.test.ts`
Expected: FAIL — `resolveStopComment` not exported.

- [ ] **Step 3: Implement resolver + wire into markStopped**

Add to `src/tracking.ts`:

```ts
import type { HomesteadContext } from "./context.ts";

type StopCtx = HomesteadContext & { readonly host: string };

export const resolveStopComment = (
  cfg: boolean | ((ctx: StopCtx) => string) | undefined,
  ctx: StopCtx,
): string | undefined => {
  if (cfg === false) return undefined;
  if (typeof cfg === "function") return cfg(ctx);
  return `homestead: agent stopped on \`${ctx.branch}\` (${ctx.host})`;
};
```

`markStopped` currently has no access to `issues`. Thread it in: change the signature to accept `issues: IssuesConfig | undefined` and the `repoName` (callers in `teardown.ts` pass `markStopped(repoName, branch)` — update those in Task 7, but for now add the param with a default of `undefined` so existing callers compile). Replace lines 125-127:

```ts
  if (state.value.commented === true) {
    const ctx: StopCtx = {
      repoName, slug: branch, branch, worktreeDir: state.value.worktreeDir ?? "",
      env: () => undefined, host,
      ...(state.value.title !== undefined ? { item: { number: state.value.number, url: state.value.url, title: state.value.title } } : {}),
    };
    const body = resolveStopComment(issues?.stopComment, ctx);
    if (body !== undefined) {
      yield* gh("gh issue comment", ["issue", "comment", ref, "--body", body]);
    }
  }
```

Add `markStopped`'s new optional last param: `issues?: IssuesConfig`.

In `src/types.ts` add to `IssuesConfig`:

```ts
  readonly stopComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
```

In `src/config.ts` `mergeValidatedConfig`, add `stopComment` to the issues hooks block:

```ts
  issues: mergeOptionalSection(config.issues, data.issues, {
    branch: config.issues?.branch,
    comment: config.issues?.comment ?? data.issues?.comment,
    stopComment: config.issues?.stopComment,
  }),
```

(No schema change needed — `stopComment` never decodes through schema; ensure `toConfigData` does NOT copy it. It isn't in `ISSUES_SCALAR_FIELDS`, so it's already excluded.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tracking.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts src/types.ts src/config.ts src/tracking.test.ts
git commit -m "feat(issues): add stopComment callback symmetric with comment"
```

---

### Task 4: `issues.reviewComment` + `closeComment` callbacks

**Files:**
- Modify: `src/types.ts` (`IssuesConfig`), `src/config.ts`, `src/tracking.ts` (`markFinished`, `markCompleted`)
- Test: `src/tracking.test.ts`

**Interfaces:**
- Produces: `reviewComment?: boolean | ((ctx) => string)` and `closeComment?: boolean | ((ctx) => string)`, both `ctx: HomesteadContext & { host: string }`. **Default: off** (no comment) — matches today (review/close post nothing).

- [ ] **Step 1: Write the failing test**

```ts
// add to src/tracking.test.ts
import { resolveReviewComment, resolveCloseComment } from "./tracking.ts";

test("review/close comments default to undefined (off)", () => {
  expect(resolveReviewComment(undefined, { branch: "b", host: "h" } as any)).toBeUndefined();
  expect(resolveCloseComment(undefined, { branch: "b", host: "h" } as any)).toBeUndefined();
});

test("review/close comments true uses default body", () => {
  expect(resolveReviewComment(true, { branch: "b", host: "h" } as any)).toBe("homestead: `b` moved to review (h)");
  expect(resolveCloseComment(true, { branch: "b", host: "h" } as any)).toBe("homestead: `b` completed (h)");
});

test("review/close comments function form wins", () => {
  expect(resolveReviewComment((c: any) => `r ${c.branch}`, { branch: "b" } as any)).toBe("r b");
  expect(resolveCloseComment((c: any) => `c ${c.branch}`, { branch: "b" } as any)).toBe("c b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tracking.test.ts`
Expected: FAIL — resolvers not exported.

- [ ] **Step 3: Implement resolvers + wire in**

Add to `src/tracking.ts`:

```ts
export const resolveReviewComment = (
  cfg: boolean | ((ctx: StopCtx) => string) | undefined, ctx: StopCtx,
): string | undefined => {
  if (cfg === undefined || cfg === false) return undefined;
  if (typeof cfg === "function") return cfg(ctx);
  return `homestead: \`${ctx.branch}\` moved to review (${ctx.host})`;
};

export const resolveCloseComment = (
  cfg: boolean | ((ctx: StopCtx) => string) | undefined, ctx: StopCtx,
): string | undefined => {
  if (cfg === undefined || cfg === false) return undefined;
  if (typeof cfg === "function") return cfg(ctx);
  return `homestead: \`${ctx.branch}\` completed (${ctx.host})`;
};
```

In `markFinished` (add `issues?: IssuesConfig` param), after the label-swap block, build a `StopCtx` from `state` (same shape as Task 3) and:

```ts
  const reviewBody = resolveReviewComment(issues?.reviewComment, ctx);
  if (reviewBody !== undefined) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", reviewBody]);
  }
```

In `markCompleted` (add `issues?: IssuesConfig` param), before the `gh issue close`:

```ts
  const closeBody = resolveCloseComment(issues?.closeComment, ctx);
  if (closeBody !== undefined) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", closeBody]);
  }
```

(For `markCompleted` the `state` may be `None`; build `ctx` from the bare `ref`/`branch` with `item` omitted when state is absent.)

In `src/types.ts` add to `IssuesConfig`:

```ts
  readonly reviewComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
  readonly closeComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
```

In `src/config.ts` add `reviewComment` and `closeComment` to the issues hooks block (same as `stopComment`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tracking.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts src/types.ts src/config.ts src/tracking.test.ts
git commit -m "feat(issues): add reviewComment + closeComment callbacks (off by default)"
```

---

### Task 5: `issues.closeReason` + `labelColor`

**Files:**
- Modify: `src/types.ts`, `src/config-schema.ts` (`labelColor` scalar), `src/config.ts`, `src/tracking.ts:16,71,145,175`
- Test: `src/tracking.test.ts`

**Interfaces:**
- Produces: `closeReason?: "completed" | "not planned" | ((ctx: HomesteadContext) => "completed" | "not planned")` (default `"completed"`); `labelColor?: string | ((ctx: { label: string; kind: "wip" | "review" }) => string)` (default `"1D76DB"`).

- [ ] **Step 1: Write the failing test**

```ts
// add to src/tracking.test.ts
import { resolveCloseReason, resolveLabelColor } from "./tracking.ts";

test("closeReason default is completed", () => {
  expect(resolveCloseReason(undefined, {} as any)).toBe("completed");
  expect(resolveCloseReason("not planned", {} as any)).toBe("not planned");
  expect(resolveCloseReason((_: any) => "not planned", {} as any)).toBe("not planned");
});

test("labelColor default is 1D76DB", () => {
  expect(resolveLabelColor(undefined, { label: "agent:wip", kind: "wip" })).toBe("1D76DB");
  expect(resolveLabelColor("FF0000", { label: "x", kind: "wip" })).toBe("FF0000");
  expect(resolveLabelColor((c) => (c.kind === "review" ? "00FF00" : "0000FF"), { label: "x", kind: "review" })).toBe("00FF00");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tracking.test.ts`
Expected: FAIL — resolvers not exported.

- [ ] **Step 3: Implement**

Add to `src/tracking.ts` (replace the `LABEL_COLOR` const usages):

```ts
export const resolveCloseReason = (
  cfg: "completed" | "not planned" | ((ctx: HomesteadContext) => "completed" | "not planned") | undefined,
  ctx: HomesteadContext,
): "completed" | "not planned" => (typeof cfg === "function" ? cfg(ctx) : cfg ?? "completed");

export const resolveLabelColor = (
  cfg: string | ((ctx: { label: string; kind: "wip" | "review" }) => string) | undefined,
  ctx: { label: string; kind: "wip" | "review" },
): string => (typeof cfg === "function" ? cfg(ctx) : cfg ?? "1D76DB");
```

Replace the three `LABEL_COLOR` uses (lines 71, 145) with `resolveLabelColor(issues?.labelColor, { label, kind: "wip" })` (markStarted) and `{ label: reviewLabel, kind: "review" }` (markFinished — thread `issues` in). Replace line 175 `--reason", "completed"` with `--reason", resolveCloseReason(issues?.closeReason, ctx)`.

`labelColor` has a scalar form, so add it to the schema: in `src/config-schema.ts` add `labelColor: Schema.optional(Schema.String)` to `IssuesConfigDataSchema` and add `"labelColor"` to `ISSUES_SCALAR_FIELDS`. But the callable form must NOT be copied by `toConfigData`. Handle like `comment`: in `src/config.ts` `toConfigData` issues block, only copy `labelColor` when it's a string:

```ts
  issues:
    config.issues === undefined ? undefined : {
      ...pickDefined(config.issues, ISSUES_SCALAR_FIELDS.filter((k) => k !== "labelColor") as any),
      ...(typeof config.issues.comment === "boolean" ? { comment: config.issues.comment } : {}),
      ...(typeof config.issues.labelColor === "string" ? { labelColor: config.issues.labelColor } : {}),
    },
```

And in `mergeValidatedConfig` issues hooks: `closeReason: config.issues?.closeReason, labelColor: config.issues?.labelColor ?? data.issues?.labelColor`.

Add both to `IssuesConfig` in `types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tracking.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts src/types.ts src/config-schema.ts src/config.ts src/tracking.test.ts
git commit -m "feat(issues): customizable closeReason + labelColor"
```

---

### Task 6: `issues.label` / `reviewLabel` / `assign` value-or-callback

**Files:**
- Modify: `src/types.ts` (`IssuesConfig`), `src/config.ts`, `src/tracking.ts` (markStarted/markStopped/markFinished)
- Test: `src/tracking.test.ts`

**Interfaces:**
- Produces: `label?: string | ((item: WorkItem) => string)`, `reviewLabel?: string | ((item: WorkItem) => string)`, `assign?: boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>)`. Defaults: `assign === true` → `["@me"]`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/tracking.test.ts
import { resolveLabel, resolveAssignees } from "./tracking.ts";

const item = { number: 7, url: "u", title: "t" } as const;

test("resolveLabel passes string through and calls function", () => {
  expect(resolveLabel("agent:wip", item)).toBe("agent:wip");
  expect(resolveLabel((i: any) => `area:${i.number}`, item)).toBe("area:7");
  expect(resolveLabel(undefined, item)).toBeUndefined();
});

test("resolveAssignees normalizes to logins", () => {
  expect(resolveAssignees(true, item)).toEqual(["@me"]);
  expect(resolveAssignees(false, item)).toEqual([]);
  expect(resolveAssignees("octocat", item)).toEqual(["octocat"]);
  expect(resolveAssignees((i: any) => [`u${i.number}`, "v"], item)).toEqual(["u7", "v"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tracking.test.ts`
Expected: FAIL — resolvers not exported.

- [ ] **Step 3: Implement**

Add to `src/tracking.ts`:

```ts
export const resolveLabel = (
  cfg: string | ((item: WorkItem) => string) | undefined, item: WorkItem,
): string | undefined => {
  const v = typeof cfg === "function" ? cfg(item) : cfg;
  const t = v?.trim();
  return t === undefined || t === "" ? undefined : t;
};

export const resolveAssignees = (
  cfg: boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>) | undefined, item: WorkItem,
): ReadonlyArray<string> => {
  if (cfg === undefined || cfg === false) return [];
  if (cfg === true) return ["@me"];
  const v = typeof cfg === "function" ? cfg(item) : cfg;
  return typeof v === "string" ? [v] : [...v];
};
```

Rework `markStarted`: replace `const label = issues.label?.trim()` with `const label = resolveLabel(issues.label, item)`; replace the assign block to loop over `resolveAssignees(issues.assign, item)` adding each via `--add-assignee`; persist the resolved label + assignees into tracking state (so `markStopped` removes the right ones — add `assignees?: ReadonlyArray<string>` to `TrackingStateSchema` as `Schema.optional(Schema.Array(Schema.String))`). In `markStopped` remove each persisted assignee; in `markFinished` use `resolveLabel(issues?.reviewLabel, item)` — but `markFinished` only has `state`, not `item`; build a synthetic `WorkItem` from `state` (`{ number, url, title: state.title ?? "" }`).

`reviewLabel`/`label` keep a scalar form, so leave them in `ISSUES_SCALAR_FIELDS` but exclude when function (mirror `labelColor` handling in `toConfigData`); re-attach callable forms in `mergeValidatedConfig`. `assign` moves from `ISSUES_SCALAR_FIELDS` data to a hook (it can now be a function) — copy only when `boolean`/`string`, re-attach function form.

Update `IssuesConfig` in `types.ts` with the three union types.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tracking.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracking.ts src/types.ts src/config-schema.ts src/config.ts src/tracking.test.ts
git commit -m "feat(issues): label/reviewLabel/assign accept callback forms"
```

---

### Task 7: Lifecycle hooks — types + config wiring

**Files:**
- Modify: `src/types.ts` (`HomesteadConfig`), `src/config.ts` (`mergeValidatedConfig` passes hooks through untouched)
- Test: `src/config.test.ts` (create if absent)

**Interfaces:**
- Produces on `HomesteadConfig`:
  - `afterLaunch?: (ctx: HomesteadContext & { paneId: string }) => Effect.Effect<void, never, HomesteadServices>`
  - `beforeTeardown?: (ctx: HomesteadContext & { verb: "kill" | "close" | "complete"; tracked: boolean }) => Effect.Effect<void, never, HomesteadServices>`
  - `afterTeardown?: (ctx: HomesteadContext & { verb: "kill" | "close" | "complete"; reviewLabel?: string }) => Effect.Effect<void, never, HomesteadServices>`

- [ ] **Step 1: Write the failing test**

```ts
// src/config.test.ts
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { validateConfigShape } from "./config.ts";

test("lifecycle hooks survive validateConfigShape untouched", () => {
  const afterLaunch = () => Effect.void;
  const beforeTeardown = () => Effect.void;
  const merged = validateConfigShape({ afterLaunch, beforeTeardown });
  expect(merged.afterLaunch).toBe(afterLaunch);
  expect(merged.beforeTeardown).toBe(beforeTeardown);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `validateConfigShape` drops unknown top-level keys (they aren't spread back) OR a type error on the hook fields.

- [ ] **Step 3: Implement**

Add the three fields to `HomesteadConfig` in `src/types.ts` (import nothing new beyond `HomesteadContext`). In `src/config.ts` `mergeValidatedConfig`, the leading `...config` spread already preserves top-level keys — confirm `afterLaunch`/`beforeTeardown`/`afterTeardown` are not overwritten by any explicit key (they aren't). No `toConfigData` change (hooks are top-level, never decoded).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts
git commit -m "feat(config): declare afterLaunch/beforeTeardown/afterTeardown hooks"
```

---

### Task 8: Fire `afterLaunch`

**Files:**
- Modify: `src/herdr/agent.ts:15-29` (after launch), thread `config`/hook into `LaunchAgentInput`
- Test: `src/herdr/agent.test.ts` (create) — assert the hook is invoked with the paneId

**Interfaces:**
- Consumes: `afterLaunch` from `HomesteadConfig`; `makeContext` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
// src/herdr/agent.test.ts
import { expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { runAfterLaunch } from "./agent.ts";
import { makeContext } from "../context.ts";

test("runAfterLaunch calls hook with paneId when present", async () => {
  const seen: string[] = [];
  const hook = (c: any) => Effect.sync(() => { seen.push(c.paneId); });
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(hook, ctx, "pane-1"));
  expect(seen).toEqual(["pane-1"]);
});

test("runAfterLaunch is a no-op when hook undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(undefined, ctx, "pane-1")); // does not throw
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/herdr/agent.test.ts`
Expected: FAIL — `runAfterLaunch` not exported.

- [ ] **Step 3: Implement**

In `src/herdr/agent.ts` add:

```ts
import type { HomesteadConfig, HomesteadContext, HomesteadServices } from "../types.ts";
import { Effect } from "effect";

export const runAfterLaunch = (
  hook: HomesteadConfig["afterLaunch"],
  ctx: HomesteadContext,
  paneId: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook({ ...ctx, paneId });
```

Add `config: HomesteadConfig` to `LaunchAgentInput`, and after line 28 call:

```ts
  yield* runAfterLaunch(
    input.config.afterLaunch,
    makeContext({ repoName, slug: plan.slug, branch, worktreeDir: plan.targetDir, item }),
    paneId,
  );
```

Update the caller in `src/issue/provision.ts` to pass `config` into `launchAgent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/herdr/agent.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/agent.ts src/herdr/agent.test.ts src/issue/provision.ts
git commit -m "feat(agent): fire afterLaunch hook after pane launch"
```

---

### Task 9: Fire `beforeTeardown` / `afterTeardown`

**Files:**
- Modify: `src/teardown.ts` (all three verbs), thread `config` into the verb functions
- Test: `src/teardown.test.ts` (create) — assert ordering: beforeTeardown before any git mutation, afterTeardown after, `tracked` correct

**Interfaces:**
- Consumes: `beforeTeardown`/`afterTeardown` from config; `makeContext`. `tracked = Option.isSome(loadTrackingState(...))`.

- [ ] **Step 1: Write the failing test**

```ts
// src/teardown.test.ts
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runBeforeTeardown, runAfterTeardown } from "./teardown.ts";
import { makeContext } from "./context.ts";

test("runBeforeTeardown passes verb + tracked", async () => {
  const seen: any[] = [];
  const hook = (c: any) => Effect.sync(() => seen.push({ verb: c.verb, tracked: c.tracked }));
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runBeforeTeardown(hook, ctx, "kill", false));
  expect(seen).toEqual([{ verb: "kill", tracked: false }]);
});

test("runAfterTeardown no-op when undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterTeardown(undefined, ctx, "close", "agent:review"));
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/teardown.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

Add to `src/teardown.ts`:

```ts
import type { HomesteadConfig, HomesteadContext, HomesteadServices } from "./types.ts";
import { makeContext } from "./context.ts";

export const runBeforeTeardown = (
  hook: HomesteadConfig["beforeTeardown"], ctx: HomesteadContext,
  verb: "kill" | "close" | "complete", tracked: boolean,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook({ ...ctx, verb, tracked });

export const runAfterTeardown = (
  hook: HomesteadConfig["afterTeardown"], ctx: HomesteadContext,
  verb: "kill" | "close" | "complete", reviewLabel?: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook(reviewLabel === undefined ? { ...ctx, verb } : { ...ctx, verb, reviewLabel });
```

Thread `config: HomesteadConfig` into `killBranch`/`closeBranch`/`completeBranch`. In each, after computing `tracked` (kill/complete already load it; for `closeBranch` add `const tracked = Option.isSome(yield* loadTrackingState(repoName, branch))`), build `ctx = makeContext({ repoName, slug: branch, branch, worktreeDir: "" })` and:
- call `runBeforeTeardown(config.beforeTeardown, ctx, verb, Option.isSome(tracked))` immediately after the opening `Console.log` and BEFORE `teardownWorktree`.
- call `runAfterTeardown(config.afterTeardown, ctx, verb, reviewLabel?)` just before the closing success `Console.log`.

Update the CLI call sites that invoke these verbs to pass `config`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/teardown.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/teardown.ts src/teardown.test.ts src/cli.ts
git commit -m "feat(teardown): fire beforeTeardown/afterTeardown hooks"
```

---

### Task 10: `HomesteadEvent` union + `defaultReporter`

**Files:**
- Create: `src/events.ts`, `src/events.test.ts`
- Modify: `src/types.ts` (`HomesteadConfig.onEvent`)

**Interfaces:**
- Produces: `HomesteadEvent` union (see spec Section 3); `defaultReporter(e): Effect<void, never, HomesteadServices>` producing today's exact lines; `emit(onEvent, e)` helper using `onEvent ?? defaultReporter`.

- [ ] **Step 1: Write the failing test**

```ts
// src/events.test.ts
import { expect, test } from "bun:test";
import { formatEvent } from "./events.ts";

test("teardown start/done match legacy lines", () => {
  expect(formatEvent({ type: "teardown", verb: "kill", branch: "b", phase: "start" })).toBe("\n▸ Killing 'b'");
  expect(formatEvent({ type: "teardown", verb: "kill", branch: "b", phase: "done" })).toBe("  ✓ killed 'b'");
  expect(formatEvent({ type: "teardown", verb: "close", branch: "b", phase: "done", reviewLabel: "agent:review" }))
    .toBe("  ✓ closed 'b' (branch kept, issue → agent:review)");
});

test("worktree.creating matches legacy", () => {
  expect(formatEvent({ type: "worktree.creating", branch: "b", targetDir: "/d" }))
    .toBe("\n▸ Creating worktree 'b' at /d");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/events.ts` with the `HomesteadEvent` union, a pure `formatEvent(e): string | undefined` that reproduces each legacy line verbatim (kill/close/complete start+done, worktree.creating with optional `from` suffix, agent.launching/launched, pr.launching/launched, issues.summary), and:

```ts
import { Console, Effect } from "effect";
import type { HomesteadServices } from "./types.ts";

export const defaultReporter = (e: HomesteadEvent): Effect.Effect<void, never, HomesteadServices> => {
  const line = formatEvent(e);
  return line === undefined ? Effect.void : Console.log(line);
};

export const emit = (
  onEvent: ((e: HomesteadEvent) => Effect.Effect<void, never, HomesteadServices>) | undefined,
  e: HomesteadEvent,
) => (onEvent ?? defaultReporter)(e);
```

Add `onEvent?: (e: HomesteadEvent) => Effect.Effect<void, never, HomesteadServices>` to `HomesteadConfig` and `export type { HomesteadEvent } from "./events.ts"` in `types.ts`.

> Match each legacy string EXACTLY, including leading `\n`, two-space indents, and glyphs `▸ ✓ ✅ ⚠`. Reference strings: see `teardown.ts:80,96,101,110,114,123,139,144`, `herdr/agent.ts:21,28`, `pr/provision.ts:35-37,52-55`, `issue/provision.ts:86-90`, `worktree/plan.ts:113`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/events.test.ts src/types.ts
git commit -m "feat(events): HomesteadEvent union + default reporter"
```

---

### Task 11: Route teardown + worktree logs through `emit`

**Files:**
- Modify: `src/teardown.ts` (replace `Console.log` status lines with `emit(config.onEvent, …)`), `src/worktree/plan.ts:113`
- Test: extend `src/events.test.ts` is enough for formatting; add a behavioral test that a custom `onEvent` receives a `teardown` event.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/teardown.test.ts
import { Ref } from "effect";

test("killBranch emits teardown events to custom onEvent", async () => {
  // Pseudization: assert emit() is called by checking the events array.
  // Drive killBranch with a stub config.onEvent that pushes events; expect
  // a {type:"teardown",verb:"kill",phase:"start"} then ...phase:"done".
  // (Use the existing test harness/fixtures for primaryRoot.)
});
```

> Implementer note: if `killBranch` is hard to drive in a unit test (it shells out to git), instead unit-test a thin extracted `teardownEvents(verb, branch, phase, reviewLabel?)` mapping and assert `emit` is wired at the call sites by code review. Prefer extracting the event construction into a pure helper so it IS unit-testable.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/teardown.test.ts`
Expected: FAIL until the call sites emit.

- [ ] **Step 3: Implement**

Replace in `src/teardown.ts`:
- `Console.log(`\n▸ Killing '${branch}'`)` → `emit(config.onEvent, { type: "teardown", verb: "kill", branch, phase: "start" })`
- `Console.log(`  ✓ killed '${branch}'`)` → `…phase: "done"`
- close/complete analogously, passing `reviewLabel` on close's done event.
Keep the warning/edge lines (`⚠ git branch -D …`, `(branch already gone)`) as `Console.log` — they're not in the event union (YAGNI).

In `src/worktree/plan.ts:113` replace with `emit(config.onEvent, { type: "worktree.creating", branch, targetDir, ...(fromSuffix ? { from } : {}) })`. Thread `config.onEvent` where needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS; types clean.

- [ ] **Step 5: Commit**

```bash
git add src/teardown.ts src/worktree/plan.ts src/teardown.test.ts
git commit -m "feat(events): route teardown + worktree logs through onEvent"
```

---

### Task 12: Route agent/PR/issue-summary logs through `emit`

**Files:**
- Modify: `src/herdr/agent.ts:21,28`, `src/pr/provision.ts:35,52`, `src/issue/provision.ts:86`
- Test: `src/events.test.ts` formatting cases for `agent.*`, `pr.*`, `issues.summary`

- [ ] **Step 1: Write the failing test**

```ts
// add to src/events.test.ts
test("issues.summary matches legacy (all vs partial)", () => {
  expect(formatEvent({ type: "issues.summary", launched: 2, total: 2 }))
    .toBe("\n✅ 2 agent(s) launched. Switch into the issue-* workspaces to drive them.");
  expect(formatEvent({ type: "issues.summary", launched: 1, total: 2 }))
    .toBe("\n✅ 1/2 agent(s) launched (1 skipped). Switch into the issue-* workspaces to drive them.");
});

test("agent.launching/launched match legacy", () => {
  expect(formatEvent({ type: "agent.launching", item: { number: 3, url: "u", title: "t" } as any, command: ["claude"], worktreeDir: "/d" }))
    .toBe("\n▸ Launching claude for issue #3 in /d");
  expect(formatEvent({ type: "agent.launched", item: { number: 3, url: "u", title: "t" } as any, command: ["claude"], paneId: "p1", worktreeDir: "/d" }))
    .toBe("  ✓ #3: claude launched in herdr pane p1 — switch in to drive it");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/events.test.ts`
Expected: FAIL — `formatEvent` doesn't yet handle these / strings mismatch.

- [ ] **Step 3: Implement**

Extend `formatEvent` for `agent.launching` (`\n▸ Launching ${command.join(" ")} for issue #${item.number} in ${worktreeDir}`), `agent.launched` (`  ✓ #${item.number}: ${command.join(" ")} launched in herdr pane ${paneId} — switch in to drive it`), `pr.launching`/`pr.launched`, `issues.summary`. Replace the matching `Console.log` calls at the listed sites with `emit(config.onEvent, …)` / `emit(onEvent, …)`.

> Note: `agent.ts:21` logs `spec.command` (a string), the union carries `command: string[]`; join with `" "` in `formatEvent` so output matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/agent.ts src/pr/provision.ts src/issue/provision.ts src/events.ts src/events.test.ts
git commit -m "feat(events): route agent/pr/issue-summary logs through onEvent"
```

---

### Task 13: `agent.surfaceLabel` callback

**Files:**
- Modify: `src/types.ts` (`AgentConfig`), `src/config.ts` (re-attach hook), `src/herdr/agent.ts:22`, `src/pr/provision.ts:49`
- Test: `src/herdr/agent.test.ts`

**Interfaces:**
- Produces: `AgentConfig.surfaceLabel?: (ctx: HomesteadContext & { kind: "issue" | "pr" }) => string`. Defaults: `kind === "issue" ? `issue-${item.number}` : `pr-${pr.number}``.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/herdr/agent.test.ts
import { resolveSurfaceLabel } from "./agent.ts";
import { makeContext } from "../context.ts";

test("surfaceLabel default issue/pr", () => {
  const issueCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", item: { number: 3, url: "u", title: "t" } as any }), kind: "issue" as const };
  expect(resolveSurfaceLabel(undefined, issueCtx)).toBe("issue-3");
  const prCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", pr: { number: 9 } as any }), kind: "pr" as const };
  expect(resolveSurfaceLabel(undefined, prCtx)).toBe("pr-9");
  expect(resolveSurfaceLabel((c) => `x-${c.kind}`, prCtx)).toBe("x-pr");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/herdr/agent.test.ts`
Expected: FAIL — `resolveSurfaceLabel` not exported.

- [ ] **Step 3: Implement**

Add to `src/herdr/agent.ts`:

```ts
type SurfaceCtx = HomesteadContext & { readonly kind: "issue" | "pr" };

export const resolveSurfaceLabel = (
  cfg: ((ctx: SurfaceCtx) => string) | undefined, ctx: SurfaceCtx,
): string => {
  if (cfg !== undefined) return cfg(ctx);
  return ctx.kind === "issue" ? `issue-${ctx.item!.number}` : `pr-${ctx.pr!.number}`;
};
```

Replace `createSurface(..., `issue-${item.number}`)` (agent.ts:22) and `createSurface(..., `pr-${pr.number}`)` (pr/provision.ts:49) with `resolveSurfaceLabel(agent.surfaceLabel, ctx)`. Add `surfaceLabel` to `AgentConfig` (`types.ts`) and re-attach in `config.ts` `mergeValidatedConfig` agent hooks: `{ prompt: …, surfaceLabel: config.agent?.surfaceLabel }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/herdr/agent.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/agent.ts src/pr/provision.ts src/types.ts src/config.ts src/herdr/agent.test.ts
git commit -m "feat(agent): surfaceLabel callback for herdr workspace names"
```

---

### Task 14: `pr.prBranch` callback

**Files:**
- Modify: `src/types.ts` (`PrConfig`), `src/config.ts`, `src/pr/branch.ts:10-13`
- Test: `src/pr/branch.test.ts` (create)

**Interfaces:**
- Produces: `PrConfig.prBranch?: (ctx: { pr: PrView; kind: "fork" | "same-repo" }) => string`. Default: `kind === "fork" ? `pr-${pr.number}` : pr.headRefName`.

- [ ] **Step 1: Write the failing test**

```ts
// src/pr/branch.test.ts
import { expect, test } from "bun:test";
import { planPrCheckout } from "./branch.ts";

const fork = { number: 9, headRefName: "feature", isCrossRepository: true } as any;
const same = { number: 9, headRefName: "feature", isCrossRepository: false } as any;

test("default fork/same-repo branch names", () => {
  expect(planPrCheckout(fork).branch).toBe("pr-9");
  expect(planPrCheckout(same).branch).toBe("feature");
});

test("prBranch callback overrides", () => {
  expect(planPrCheckout(fork, (c) => `custom-${c.pr.number}-${c.kind}`).branch).toBe("custom-9-fork");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pr/branch.test.ts`
Expected: FAIL — `planPrCheckout` takes one arg.

- [ ] **Step 3: Implement**

```ts
// src/pr/branch.ts
export const planPrCheckout = (
  pr: PrView,
  prBranch?: (ctx: { pr: PrView; kind: "fork" | "same-repo" }) => string,
): PrCheckout => {
  const kind = pr.isCrossRepository ? "fork" : "same-repo";
  const fallback = kind === "fork" ? `pr-${pr.number}` : pr.headRefName;
  return { kind, branch: prBranch ? prBranch({ pr, kind }) : fallback };
};
```

Update the caller (PR provisioning) to pass `config.pr?.prBranch`. Add `prBranch` to `PrConfig` (`types.ts`) and re-attach in `config.ts` pr hooks.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/pr/branch.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pr/branch.ts src/types.ts src/config.ts src/pr/branch.test.ts
git commit -m "feat(pr): prBranch callback for fork branch naming"
```

---

### Task 15: `agent.command` callable form

**Files:**
- Modify: `src/types.ts` (`AgentConfig`), `src/config.ts` (`toConfigData` skip-when-function, re-attach), `src/agent/defaults.ts:21`
- Test: `src/agent/defaults.test.ts` (create)

**Interfaces:**
- Produces: `AgentConfig.command?: ReadonlyArray<string> | ((ctx: HomesteadContext & { args: ReadonlyArray<string> }) => ReadonlyArray<string>)`. Resolution happens at launch with the work-item context.

> **Caveat (spec open question resolved):** the callable `command` must be resolved at the launch call site where the context exists, NOT in `resolveAgentDefaults` (which has no context). Resolve to a concrete `string[]` before `resolveAgentDefaults`, OR pass the context into a new `resolveCommand(agent.command, ctx)` and feed its result to `toSpec`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/defaults.test.ts
import { expect, test } from "bun:test";
import { resolveCommand } from "./defaults.ts";

const ctx = { item: { number: 3, title: "t" }, args: ["--foo"] } as any;

test("resolveCommand passes array through", () => {
  expect(resolveCommand(["claude"], ctx)).toEqual(["claude"]);
});
test("resolveCommand calls function with ctx", () => {
  expect(resolveCommand((c: any) => ["claude", "--model", c.item.number === 3 ? "opus" : "sonnet"], ctx))
    .toEqual(["claude", "--model", "opus"]);
});
test("resolveCommand defaults to ['claude']", () => {
  expect(resolveCommand(undefined, ctx)).toEqual(["claude"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/defaults.test.ts`
Expected: FAIL — `resolveCommand` not exported.

- [ ] **Step 3: Implement**

Add to `src/agent/defaults.ts`:

```ts
import type { HomesteadContext } from "../context.ts";

export const resolveCommand = (
  cfg: ReadonlyArray<string> | ((ctx: HomesteadContext & { args: ReadonlyArray<string> }) => ReadonlyArray<string>) | undefined,
  ctx: HomesteadContext & { args: ReadonlyArray<string> },
): ReadonlyArray<string> => {
  if (typeof cfg === "function") return cfg(ctx);
  return cfg ?? DEFAULT_AGENT_COMMAND;
};
```

At the launch site (`herdr/agent.ts` / wherever `toSpec(agent)` is called with a context), resolve `command` first and pass a concrete-array agent into `resolveAgentDefaults`/`toSpec`.

In `src/config.ts` `toConfigData` agent block, copy `command` only when it's NOT a function (currently it spreads `command` unconditionally — guard it):

```ts
        ...(Array.isArray(config.agent.command) ? { command: [...config.agent.command] } : {}),
```

Re-attach the callable form in `mergeValidatedConfig` agent hooks: `command: config.agent?.command ?? data.agent?.command`.

Update `AgentConfig` in `types.ts` to the union and remove `command` from `AGENT_DATA_FIELDS` reliance for the function case (the guard handles it).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/agent/defaults.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/defaults.ts src/types.ts src/config.ts src/agent/defaults.test.ts src/herdr/agent.ts
git commit -m "feat(agent): command accepts callback form resolved at launch"
```

---

### Task 16: `setup` callable form

**Files:**
- Modify: `src/types.ts` (`HomesteadConfig.setup`), `src/config.ts`, `src/worktree/provision.ts:90`
- Test: `src/worktree/provision.test.ts` (create) — resolver only

**Interfaces:**
- Produces: `setup?: ReadonlyArray<SetupStep> | ((ctx: HomesteadContext & { plan: Plan }) => ReadonlyArray<SetupStep>)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/worktree/provision.test.ts
import { expect, test } from "bun:test";
import { resolveSetup } from "./provision.ts";

const ctx = { branch: "docs-fix", plan: {} } as any;

test("resolveSetup passes array through", () => {
  const steps = [{ label: "install", run: ["bun", "install"] }];
  expect(resolveSetup(steps, ctx)).toBe(steps);
});
test("resolveSetup calls function and can branch", () => {
  const fn = (c: any) => (c.branch.startsWith("docs") ? [] : [{ label: "seed", run: ["bun", "seed"] }]);
  expect(resolveSetup(fn, ctx)).toEqual([]);
});
test("resolveSetup undefined → []", () => {
  expect(resolveSetup(undefined, ctx)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worktree/provision.test.ts`
Expected: FAIL — `resolveSetup` not exported.

- [ ] **Step 3: Implement**

Add to `src/worktree/provision.ts`:

```ts
import type { HomesteadContext } from "../context.ts";

export const resolveSetup = (
  cfg: ReadonlyArray<SetupStep> | ((ctx: HomesteadContext & { plan: Plan }) => ReadonlyArray<SetupStep>) | undefined,
  ctx: HomesteadContext & { plan: Plan },
): ReadonlyArray<SetupStep> => (typeof cfg === "function" ? cfg(ctx) : cfg ?? []);
```

In `runSetup`, replace `for (const step of config.setup ?? [])` with `for (const step of resolveSetup(config.setup, ctx))` where `ctx` is built from `plan`/`repo` via `makeContext`. The function form bypasses schema validation, so validate the returned steps' shape minimally (each has non-empty `run`) — reuse the existing empty-command check already at provision.ts:92-97.

In `src/config.ts`: `toConfigData` currently sets `setup: config.setup` (decoded via `emptySetup`). Guard: pass `setup` to the schema only when it's an array; when it's a function, set `setup: []` for the decoded shape and re-attach the function in `mergeValidatedConfig` (`setup: typeof config.setup === "function" ? config.setup : data.setup`).

Update `HomesteadConfig.setup` type in `types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/worktree/provision.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/provision.ts src/types.ts src/config.ts src/worktree/provision.test.ts
git commit -m "feat(setup): setup accepts callback form for computed steps"
```

---

### Task 17: `pr.checks` + `ports[].base` callable forms

**Files:**
- Modify: `src/types.ts` (`PrConfig`, `PortSpec` context), `src/config.ts`, `src/pr/prompt.ts:32`, `src/worktree/plan.ts:77`
- Test: `src/pr/prompt.test.ts`, extend `src/worktree` tests

**Interfaces:**
- Produces: `PrConfig.checks?: string | ((ctx: PrPromptContext) => string)`; `PortSpec.base?: number | ((ctx: HomesteadContext) => number)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/pr/prompt.test.ts
import { expect, test } from "bun:test";
import { resolveChecks } from "./prompt.ts";

test("checks string passthrough + function", () => {
  expect(resolveChecks("bun test", { pr: {} } as any)).toBe("bun test");
  expect(resolveChecks((c: any) => (c.pr.baseRefName === "main" ? "e2e" : "smoke"), { pr: { baseRefName: "main" } } as any)).toBe("e2e");
  expect(resolveChecks(undefined, { pr: {} } as any)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pr/prompt.test.ts`
Expected: FAIL — `resolveChecks` not exported.

- [ ] **Step 3: Implement**

`resolveChecks` in `pr/prompt.ts`: `typeof cfg === "function" ? cfg(ctx) : cfg`. Use it where `checks` feeds the prompt (prompt.ts:32). For `ports[].base`: add a `resolvePortBase(base, ctx)` helper; in `worktree/plan.ts:77` resolve `spec.base` before `nextFreePort`. Schema: `base` keeps `Schema.Number`; callable form lives in a `PortSpec` interface override in `types.ts` and `toConfigData` must strip function `base` before decode (map ports: when `base` is a function, substitute `0` for decode and re-attach the real spec from the original config). Simpler: keep ports entirely in `types.ts`-land for the callable case — decode only the scalar ports, re-merge originals. Implement whichever keeps decode total; document the choice in a code comment.

For `pr.checks`: it has a scalar form in `PR_DATA_FIELDS`; guard in `toConfigData` (copy only when string) and re-attach function in `mergeValidatedConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/pr/prompt.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pr/prompt.ts src/worktree/plan.ts src/types.ts src/config.ts src/pr/prompt.test.ts
git commit -m "feat(config): pr.checks + ports[].base accept callback forms"
```

---

### Task 18: Unify existing callbacks onto `HomesteadContext` + migrate dogfood config

**Files:**
- Modify: `src/types.ts` (`worktreeDir`, `WorktreeContext`/`env.derive`, `AgentPromptContext`, `TrackingContext`, `PrPromptContext` re-expressed over `HomesteadContext`), all call sites that construct these, `homestead.config.ts`
- Modify: `src/generated/homestead.config.types.d.ts` (regenerate)
- Test: `bun test` full suite + `bun run typecheck`

**Interfaces:**
- Consumes: `HomesteadContext` (Task 1). This is the **breaking** unification.

- [ ] **Step 1: Re-express context types over the base**

In `src/types.ts`:
- `worktreeDir?: (ctx: HomesteadContext) => string` — but `worktreeDir` is being computed here. Resolve open question: omit the `worktreeDir` field for this one callback by passing `makeContext({ ..., worktreeDir: "" })`, and document that `ctx.worktreeDir` is empty inside the `worktreeDir` callback itself.
- `AgentPromptContext = HomesteadContext & { args: ReadonlyArray<string> }` (drop the standalone interface, keep an alias).
- `TrackingContext = HomesteadContext & { host: string }`.
- Keep `WorktreeContext` as `HomesteadContext & { targetDir: string; primaryRoot: string }` for `env.derive`/`afterSetup`.

- [ ] **Step 2: Run typecheck to see all break sites**

Run: `bun run typecheck`
Expected: FAIL — list of call sites constructing old context shapes.

- [ ] **Step 3: Update each call site to use `makeContext`**

Walk the typecheck errors; replace inline context object literals (`{ item, branch, worktreeDir, repoName, args }` at `herdr/agent.ts:24`, `{ repoName, slug, branch }` at `worktree/plan.ts:50`, the `TrackingContext` literal at `tracking.ts:79`, etc.) with `makeContext(...)` plus the stage extras. Keep `env.derive`/`afterSetup` receiving the `WorktreeContext` intersection.

- [ ] **Step 4: Migrate the dogfood config + regenerate types**

Update `homestead.config.ts` to the new signatures (its `branch: (item) => String(item.number)` is unaffected; add a demonstrative `stopComment`/`afterTeardown`/`surfaceLabel` if useful as living docs). Regenerate `src/generated/homestead.config.types.d.ts` via the project's generation script (check `package.json` scripts / `scripts/`).

- [ ] **Step 5: Run full verification**

Run: `bun test && bun run typecheck`
Expected: PASS; types clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/herdr/agent.ts src/worktree/plan.ts src/tracking.ts src/issue/provision.ts homestead.config.ts src/generated/homestead.config.types.d.ts
git commit -m "feat(config)!: unify all callback context onto HomesteadContext

BREAKING CHANGE: callback signatures (branch, prompt, worktreeDir, env.derive,
pr.*Prompt, issues.comment) now receive a unified HomesteadContext."
```

---

### Task 19: Docs + version bump

**Files:**
- Modify: `README.md` (document every new callback + the breaking change + migration), `package.json` (version)
- Modify: `homestead.config.ts` header comment if behavior demonstrated

- [ ] **Step 1: Write the README section**

Document: the unified `HomesteadContext`; lifecycle hooks; `onEvent` + the event union; every `issues.*` callback with default bodies; `surfaceLabel`, `prBranch`, `agent.command`/`setup`/`pr.checks`/`ports[].base` callable forms. Include a "Migrating from <prev>" subsection listing the changed signatures.

- [ ] **Step 2: Bump version**

Edit `package.json` version (minor or major per the project's convention for a breaking change — this is breaking, so major-ish per semver; match the repo's release pattern seen in git log `release: vX.Y.Z`).

- [ ] **Step 3: Verify build**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: document config callbacks + lifecycle hooks; note breaking change"
```

---

## Self-Review

**Spec coverage:**
- §1 unified context → Tasks 1, 18. §1 enabler (TrackingState widen) → Task 2. ✓
- §2 lifecycle hooks → Tasks 7, 8, 9. ✓
- §3 onEvent reporter → Tasks 10, 11, 12. ✓
- §4 issue message callbacks (stop/review/close comment, closeReason, labelColor, label/reviewLabel/assign) → Tasks 3, 4, 5, 6. ✓
- §5 field callbacks (command, setup, pr.checks, ports.base, surfaceLabel, prBranch) → Tasks 13, 14, 15, 16, 17. ✓
- Open question 1 (worktreeDir self-reference) → resolved in Task 18 Step 1 (empty `worktreeDir` field, documented). ✓
- Open question 2 (env at teardown) → context built with `env: () => undefined` at teardown (Tasks 3/9). ✓
- Docs + breaking-change note → Task 19. ✓

**Placeholder scan:** Task 17's ports handling intentionally offers two implementation strategies and tells the engineer to pick the one that keeps decode total — this is a real design latitude, not a placeholder, and both options are spelled out. Task 11 Step 1 is pseudo-code with an explicit instruction to extract a pure helper; flagged, not hidden.

**Type consistency:** `HomesteadContext` shape is identical across Tasks 1/3/8/9/13/15/16. `makeContext` signature stable. `resolve*` helper names are unique per concern. `HomesteadEvent` union defined once (Task 10), extended by formatting only (Tasks 11–12).
