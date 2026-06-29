import { afterEach, beforeEach, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import { resolve } from "node:path";
import {
  classifyProvisioning,
  detectPortConflicts,
  detectStaleState,
  hasFailure,
  scanDoctor,
  type DoctorReport,
} from "./doctor.ts";
import { computePortEdits } from "./worktree/plan.ts";
import { PROVISION_MARKER_RELPATH } from "./worktree/marker.ts";
import { makeContext } from "./context.ts";
import { slugify } from "./text.ts";
import type { HomesteadConfig, PortSpec } from "./types.ts";
import type { Repo } from "./worktree/repo.ts";
import type { TrackedBranch, TrackingState } from "./tracking.ts";

// ---------------------------------------------------------------------------
// classifyProvisioning — the pure half-provisioned classifier. No fs: every
// disk fact (env present? marker present? owned keys all filled?) is a boolean.
// ---------------------------------------------------------------------------

test("classifyProvisioning: marker present ⇒ provisioned (PASS)", () => {
  expect(classifyProvisioning({ hasEnv: true, hasMarker: true, ownedKeysPresent: true }).kind).toBe(
    "provisioned",
  );
  // Marker is the source of truth even if an owned key was blanked by hand.
  expect(classifyProvisioning({ hasEnv: true, hasMarker: true, ownedKeysPresent: false }).kind).toBe(
    "provisioned",
  );
});

test("classifyProvisioning: .env present + marker absent + owned key missing ⇒ half-provisioned (FAIL)", () => {
  expect(
    classifyProvisioning({ hasEnv: true, hasMarker: false, ownedKeysPresent: false }).kind,
  ).toBe("half-provisioned");
});

test("classifyProvisioning: .env present + marker absent + all owned keys present ⇒ legacy (WARN)", () => {
  expect(classifyProvisioning({ hasEnv: true, hasMarker: false, ownedKeysPresent: true }).kind).toBe(
    "legacy",
  );
});

test("classifyProvisioning: neither .env nor marker ⇒ not a homestead worktree", () => {
  expect(
    classifyProvisioning({ hasEnv: false, hasMarker: false, ownedKeysPresent: true }).kind,
  ).toBe("not-homestead");
});

// ---------------------------------------------------------------------------
// detectPortConflicts — duplicate .env claims for the same port key across
// sibling worktrees. Feeds in fixture env strings; reuses readEnvVar internally.
// ---------------------------------------------------------------------------

test("detectPortConflicts: two siblings claiming the same port key ⇒ FAIL pair", () => {
  const conflicts = detectPortConflicts(
    [
      { label: "feat-a", env: "WEB_PORT=5310\nAPI_PORT=5400\n" },
      { label: "feat-b", env: "WEB_PORT=5310\nAPI_PORT=5401\n" },
    ],
    ["WEB_PORT", "API_PORT"],
  );
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.key).toBe("WEB_PORT");
  expect(conflicts[0]!.value).toBe("5310");
  expect([...conflicts[0]!.labels].sort()).toEqual(["feat-a", "feat-b"]);
});

test("detectPortConflicts: all-distinct values ⇒ no conflicts", () => {
  const conflicts = detectPortConflicts(
    [
      { label: "feat-a", env: "WEB_PORT=5310\n" },
      { label: "feat-b", env: "WEB_PORT=5311\n" },
    ],
    ["WEB_PORT"],
  );
  expect(conflicts).toEqual([]);
});

// ---------------------------------------------------------------------------
// detectStaleState — tracking state whose worktreeDir is gone / not a live
// git worktree. Pure: live dirs are a pre-resolved Set.
// ---------------------------------------------------------------------------

const trackState = (worktreeDir: string | undefined): TrackingState => ({ kind: "issue", worktreeDir });
const tracked = (branch: string, worktreeDir: string | undefined): TrackedBranch => ({
  branch,
  state: trackState(worktreeDir),
});

test("detectStaleState: worktreeDir absent from live set ⇒ WARN; present ⇒ no finding", () => {
  const live = "/wt/live";
  const gone = "/wt/gone";
  const stale = detectStaleState(
    [tracked("live", live), tracked("gone", gone)],
    new Set([resolve(live)]),
  );
  expect(stale.map((s) => s.branch)).toEqual(["gone"]);
});

test("detectStaleState: undefined worktreeDir ⇒ WARN", () => {
  const stale = detectStaleState([tracked("ghost", undefined)], new Set());
  expect(stale.map((s) => s.branch)).toEqual(["ghost"]);
});

// ---------------------------------------------------------------------------
// hasFailure — drives the exit code: non-zero iff any finding is a FAIL.
// ---------------------------------------------------------------------------

test("hasFailure: true when any FAIL present, false when only PASS/WARN", () => {
  const passWarn: DoctorReport = {
    worktrees: [
      { label: "a", path: "/wt/a", findings: [{ severity: "pass", message: "ok" }] },
      { label: "b", path: "/wt/b", findings: [{ severity: "warn", message: "hmm" }] },
    ],
    global: [{ severity: "warn", message: "stale" }],
  };
  expect(hasFailure(passWarn)).toBe(false);

  const withFail: DoctorReport = {
    ...passWarn,
    worktrees: [
      ...passWarn.worktrees,
      { label: "c", path: "/wt/c", findings: [{ severity: "fail", message: "broken" }] },
    ],
  };
  expect(hasFailure(withFail)).toBe(true);
});

// ---------------------------------------------------------------------------
// --fix idempotency guard — re-running setup over a .env that already claims
// its owned ports must yield the SAME envEdits (existing values preserved).
// This is the property `homestead doctor --fix` leans on for safety.
// ---------------------------------------------------------------------------

test("computePortEdits keeps already-assigned ports (the --fix idempotency guarantee)", () => {
  const ports: ReadonlyArray<PortSpec> = [
    { key: "WEB_PORT", base: 5300 },
    { key: "API_PORT", base: 5400 },
  ];
  const ctx = makeContext({ repoName: "acme", slug: "feat", branch: "feat", worktreeDir: "/wt/feat" });
  const targetEnv = "WEB_PORT=5310\nAPI_PORT=5402\n";
  // Pretend the allocator would have picked from a fresh range — existing wins.
  const used = new Map<string, Set<number>>([
    ["WEB_PORT", new Set([5300])],
    ["API_PORT", new Set([5400])],
  ]);
  const edits = computePortEdits(targetEnv, ports, used, ctx);
  expect(edits).toEqual([
    ["WEB_PORT", "5310"],
    ["API_PORT", "5402"],
  ]);
});

// ---------------------------------------------------------------------------
// scanDoctor — read-only end-to-end over a temp sandbox. Proves the assembly:
// half-provisioned ⇒ FAIL + a repair target; a marker flips it to PASS. Same
// sandbox approach as gc.test.ts (unique repoName isolates ~/.homestead/state).
// ---------------------------------------------------------------------------

let sandbox: string;
let repoName: string;
let REPO: Repo;

const stateDirFor = (name: string) => `${os.homedir()}/.homestead/state/${slugify(name)}`;

beforeEach(() => {
  sandbox = fsSync.mkdtempSync(`${os.tmpdir()}/homestead-doctor-`);
  repoName = `doctordemo_${sandbox.slice(sandbox.lastIndexOf("/") + 1)}`;
  REPO = { startCwd: sandbox, primaryRoot: `${sandbox}/primary`, repoName };
  fsSync.mkdirSync(REPO.primaryRoot, { recursive: true });
});

afterEach(() => {
  fsSync.rmSync(sandbox, { recursive: true, force: true });
  fsSync.rmSync(stateDirFor(repoName), { recursive: true, force: true });
});

const porcelain = (entries: ReadonlyArray<{ path: string; branch?: string }>): string =>
  entries
    .map((e) => `worktree ${e.path}\n${e.branch !== undefined ? `branch refs/heads/${e.branch}\n` : ""}`)
    .join("\n");

const run = <A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const PORT_CONFIG: HomesteadConfig = { ports: [{ key: "WEB_PORT", base: 5300 }] };

test("scanDoctor: .env present, owned port missing, no marker ⇒ FAIL + a repair target", async () => {
  const wtPath = `${sandbox}/wt/feat`;
  fsSync.mkdirSync(wtPath, { recursive: true });
  fsSync.writeFileSync(`${wtPath}/.env`, "SOME_OTHER=1\n"); // WEB_PORT absent ⇒ half-provisioned

  const scan = await run(
    scanDoctor(
      REPO,
      PORT_CONFIG,
      Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }, { path: wtPath, branch: "feat" }])),
    ),
  );

  expect(hasFailure(scan.report)).toBe(true);
  const wt = scan.report.worktrees.find((w) => w.label === "feat")!;
  expect(wt.findings.some((f) => f.severity === "fail")).toBe(true);
  expect(scan.repairs.map((r) => r.branch)).toEqual(["feat"]);
});

test("scanDoctor: a provision marker flips the same worktree to PASS, no repair", async () => {
  const wtPath = `${sandbox}/wt/feat`;
  fsSync.mkdirSync(`${wtPath}/${PROVISION_MARKER_RELPATH.split("/")[0]}`, { recursive: true });
  fsSync.writeFileSync(`${wtPath}/.env`, "SOME_OTHER=1\n");
  fsSync.writeFileSync(
    `${wtPath}/${PROVISION_MARKER_RELPATH}`,
    JSON.stringify({ version: 1, completedAt: "2026-06-28T00:00:00.000Z", ports: ["WEB_PORT"], setupSteps: 1 }),
  );

  const scan = await run(
    scanDoctor(
      REPO,
      PORT_CONFIG,
      Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }, { path: wtPath, branch: "feat" }])),
    ),
  );

  expect(hasFailure(scan.report)).toBe(false);
  expect(scan.repairs).toEqual([]);
  const wt = scan.report.worktrees.find((w) => w.label === "feat")!;
  expect(wt.findings.some((f) => f.severity === "pass" && f.message.startsWith("provisioned"))).toBe(true);
});

test("scanDoctor: the primary checkout is never audited", async () => {
  const scan = await run(
    scanDoctor(REPO, PORT_CONFIG, Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }]))),
  );
  expect(scan.report.worktrees).toEqual([]);
});
