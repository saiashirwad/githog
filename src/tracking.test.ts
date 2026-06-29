import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  AGENT_MARKER_FILE,
  type AgentMarker,
  readAgentMarker,
  resolveAssignees,
  resolveCloseComment,
  resolveCloseReason,
  resolveLabel,
  resolveLabelColor,
  resolveReviewComment,
  resolveReviewLabel,
  resolveStopComment,
  TrackingStateSchema,
  writeAgentMarker,
} from "./tracking.ts";

const item = { number: 7, url: "u", title: "t" } as const;

test("TrackingState decodes legacy state without title/worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const legacy = decode({ number: 7, url: "u", label: "agent:wip" });
  expect(legacy.number).toBe(7);
  expect(legacy.title).toBeUndefined();
  expect(legacy.worktreeDir).toBeUndefined();
});

test("legacy issue state file (no kind) decodes as kind: issue", () => {
  // Backward compat: every state file written before the discriminator existed
  // has no `kind` — it must still decode, defaulting to issue-work.
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const legacy = decode({ number: 7, url: "https://github.com/o/r/issues/7", title: "Fix bug" });
  expect(legacy.kind).toBe("issue");
  expect(legacy.number).toBe(7);
  expect(legacy.spawn).toBeUndefined();
});

test("spawn state file decodes + round-trips with no number/url", async () => {
  const spawn = {
    kind: "spawn" as const,
    worktreeDir: "/tmp/wt",
    spawn: {
      spawnedBy: "agent spawn",
      paneId: "pane_123",
      promptSlug: "fix-flaky-login-test",
      spawnedAt: "2026-06-29T00:00:00.000Z",
    },
  };
  const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(TrackingStateSchema)(spawn));
  const json = JSON.stringify(encoded);
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(json),
  );
  expect(decoded).toEqual(spawn);
  expect(decoded.number).toBeUndefined();
  expect(decoded.url).toBeUndefined();
});

test("spawn state with missing number decodes without throwing", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const decoded = decode({
    kind: "spawn",
    spawn: { spawnedBy: "agent spawn", spawnedAt: "2026-06-29T00:00:00.000Z" },
  });
  expect(decoded.kind).toBe("spawn");
  expect(decoded.number).toBeUndefined();
});

test("TrackingState round-trips title + worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const s = decode({ number: 7, url: "u", title: "Fix bug", worktreeDir: "/tmp/wt" });
  expect(s.title).toBe("Fix bug");
  expect(s.worktreeDir).toBe("/tmp/wt");
});

test("tracking state encode/decode round-trip", async () => {
  const state = {
    kind: "issue" as const,
    number: 42,
    url: "https://github.com/o/r/issues/42",
    label: "agent:working",
    assigned: true,
    commented: true,
  };
  const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(TrackingStateSchema)(state));
  const json = JSON.stringify(encoded);
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(json),
  );
  expect(decoded).toEqual(state);
});

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

test("closeReason default is completed", () => {
  expect(resolveCloseReason(undefined, {} as any)).toBe("completed");
  expect(resolveCloseReason("not planned", {} as any)).toBe("not planned");
  expect(resolveCloseReason((_: any) => "not planned", {} as any)).toBe("not planned");
});

test("resolveLabel passes string through and calls function", () => {
  expect(resolveLabel("agent:wip", item)).toBe("agent:wip");
  expect(resolveLabel((i: any) => `area:${i.number}`, item)).toBe("area:7");
  expect(resolveLabel(undefined, item)).toBeUndefined();
});

test("resolveReviewLabel uses tracking item for function reviewLabel", () => {
  const state = Option.some({ kind: "issue" as const, number: 7, url: "u", title: "t" });
  expect(resolveReviewLabel("agent:review", { reviewLabel: (i) => `area:${i.number}` }, state)).toBe("area:7");
  expect(resolveReviewLabel("agent:review", { reviewLabel: "agent:wip" }, state)).toBe("agent:wip");
  expect(resolveReviewLabel("agent:review", undefined, Option.none())).toBe("agent:review");
});

test("resolveAssignees normalizes to logins", () => {
  expect(resolveAssignees(true, item)).toEqual(["@me"]);
  expect(resolveAssignees(false, item)).toEqual([]);
  expect(resolveAssignees("octocat", item)).toEqual(["octocat"]);
  expect(resolveAssignees((i: any) => [`u${i.number}`, "v"], item)).toEqual(["u7", "v"]);
});

test("labelColor default is 1D76DB", () => {
  expect(resolveLabelColor(undefined, { label: "agent:wip", kind: "wip" })).toBe("1D76DB");
  expect(resolveLabelColor("FF0000", { label: "x", kind: "wip" })).toBe("FF0000");
  expect(resolveLabelColor((c) => (c.kind === "review" ? "00FF00" : "0000FF"), { label: "x", kind: "review" })).toBe(
    "00FF00",
  );
});

const withTempDir = <A>(use: (dir: string) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "homestead-marker-" });
    return yield* use(dir).pipe(Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)));
  }).pipe(Effect.provide(BunServices.layer));

test("writeAgentMarker / readAgentMarker round-trip", async () => {
  const marker: AgentMarker = {
    kind: "spawn",
    spawnedBy: "agent spawn",
    paneId: "pane_abc",
    promptSlug: "fix-flaky-login-test",
    statusFile: "~/.homestead/status/repo/branch.json",
    createdAt: "2026-06-29T00:00:00.000Z",
  };
  const readBack = await Effect.runPromise(
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeAgentMarker(dir, marker);
        return yield* readAgentMarker(dir);
      }),
    ),
  );
  expect(Option.isSome(readBack)).toBe(true);
  expect(Option.getOrThrow(readBack)).toEqual(marker);
});

test("writeAgentMarker writes the .homestead-agent.json file", async () => {
  const present = await Effect.runPromise(
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeAgentMarker(dir, {
          kind: "spawn",
          spawnedBy: "agent spawn",
          createdAt: "2026-06-29T00:00:00.000Z",
        });
        return yield* fs.exists(path.join(dir, AGENT_MARKER_FILE));
      }),
    ),
  );
  expect(present).toBe(true);
});

test("readAgentMarker returns none when the marker is absent", async () => {
  const result = await Effect.runPromise(withTempDir((dir) => readAgentMarker(dir)));
  expect(Option.isNone(result)).toBe(true);
});
