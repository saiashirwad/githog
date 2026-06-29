import { Console, Effect, FileSystem, Option, Path } from "effect";
import { resolve as resolvePath } from "node:path";
import type { WorktreePorcelainEntry } from "./git/porcelain.ts";
import { parseGitStatus } from "./gc.ts";
import { Git } from "./git/service.ts";
import { probeTcp } from "./process.ts";
import { readEnvVar, slugify } from "./text.ts";
import { listTrackedBranches, loadTrackingState, type TrackedBranch } from "./tracking.ts";
import { readProvisionMarker } from "./worktree/marker.ts";
import { makeWorktreeContext, type Target } from "./worktree/plan.ts";
import { provisionTarget } from "./worktree/index.ts";
import type { Repo } from "./worktree/repo.ts";
import type { HomesteadConfig } from "./types.ts";

// `homestead doctor` — a read-only auditor for the four ways an isolated worktree
// silently goes bad: a crash left it half-provisioned, two worktrees fight over a
// port, the user's own work hides in an auto-spawnable-looking worktree, or a
// tracking-state file outlived its worktree. Like gc.ts it splits SCAN (gather
// every disk/git fact, never mutate) from pure CLASSIFY helpers (unit-tested with
// no fs/sockets). `--fix` repairs ONLY the half-provisioned case by re-running
// the idempotent provisioning pipeline; it never touches the other three.

const PROBE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 500;

export type Severity = "pass" | "warn" | "fail";

export interface Finding {
  readonly severity: Severity;
  readonly message: string;
}

export interface WorktreeReport {
  readonly label: string;
  readonly path: string;
  readonly findings: ReadonlyArray<Finding>;
}

export interface DoctorReport {
  // Findings that belong to a specific worktree.
  readonly worktrees: ReadonlyArray<WorktreeReport>;
  // Repo-wide findings with no single worktree (stale tracking state).
  readonly global: ReadonlyArray<Finding>;
}

// ---------------------------------------------------------------------------
// Pure classifiers — no fs/git/sockets. Every disk fact is a plain value, so
// the safety rules are exercised directly in doctor.test.ts.
// ---------------------------------------------------------------------------

// Check 1 — half-provisioned. The marker is the source of truth; the env-key
// inference is only a grace WARN for worktrees made before the marker existed.
//   marker present                                   ⇒ provisioned (PASS)
//   .env present, no marker, an owned key missing    ⇒ half-provisioned (FAIL)
//   .env present, no marker, all owned keys present  ⇒ legacy (WARN, inferred)
//   neither .env nor marker                          ⇒ not a homestead worktree
export type ProvisioningStatus =
  | { readonly kind: "provisioned" }
  | { readonly kind: "half-provisioned" }
  | { readonly kind: "legacy" }
  | { readonly kind: "not-homestead" };

export const classifyProvisioning = (input: {
  readonly hasEnv: boolean;
  readonly hasMarker: boolean;
  // Every owned key (config.ports + env.derive) present and non-blank in `.env`.
  // Vacuously true when the repo owns no keys (then legacy grace applies).
  readonly ownedKeysPresent: boolean;
}): ProvisioningStatus => {
  if (input.hasMarker) return { kind: "provisioned" };
  if (!input.hasEnv) return { kind: "not-homestead" };
  return input.ownedKeysPresent ? { kind: "legacy" } : { kind: "half-provisioned" };
};

// Check 2 (deterministic half) — two worktrees' `.env` files claim the SAME
// value for the same port key. The allocator normally prevents this; a crash
// mid-allocation or a manual edit can produce it.
export interface PortConflict {
  readonly key: string;
  readonly value: string;
  readonly labels: ReadonlyArray<string>;
}

export const detectPortConflicts = (
  worktrees: ReadonlyArray<{ readonly label: string; readonly env: string }>,
  portKeys: ReadonlyArray<string>,
): ReadonlyArray<PortConflict> => {
  const conflicts: Array<PortConflict> = [];
  for (const key of portKeys) {
    const byValue = new Map<string, Array<string>>();
    for (const wt of worktrees) {
      const value = readEnvVar(wt.env, key);
      if (value === undefined || value === "") continue;
      const labels = byValue.get(value) ?? [];
      labels.push(wt.label);
      byValue.set(value, labels);
    }
    for (const [value, labels] of byValue) {
      if (labels.length > 1) conflicts.push({ key, value, labels });
    }
  }
  return conflicts;
};

// Check 4 — stale tracking state. A state file whose `worktreeDir` is gone on
// disk (or no longer a live git worktree) is stale: teardown never ran, so its
// WIP signals linger. `liveDirs` holds resolved paths of git worktrees that
// exist on disk. doctor only diagnoses; `gc` reclaims.
export interface StaleState {
  readonly branch: string;
  readonly worktreeDir: string | undefined;
}

export const detectStaleState = (
  stateFiles: ReadonlyArray<TrackedBranch>,
  liveDirs: ReadonlySet<string>,
): ReadonlyArray<StaleState> => {
  const stale: Array<StaleState> = [];
  for (const { branch, state } of stateFiles) {
    const dir = state.worktreeDir;
    if (dir !== undefined && liveDirs.has(resolvePath(dir))) continue;
    stale.push({ branch, worktreeDir: dir });
  }
  return stale;
};

// Drives the exit code: doctor exits non-zero iff any finding is a FAIL.
export const hasFailure = (report: DoctorReport): boolean =>
  report.global.some((f) => f.severity === "fail") ||
  report.worktrees.some((wt) => wt.findings.some((f) => f.severity === "fail"));

const countSeverity = (report: DoctorReport, severity: Severity): number =>
  report.global.filter((f) => f.severity === severity).length +
  report.worktrees.reduce(
    (acc, wt) => acc + wt.findings.filter((f) => f.severity === severity).length,
    0,
  );

// ---------------------------------------------------------------------------
// Scan — read-only. Gathers every disk/git fact, runs the classifiers, and
// returns the report plus the list of half-provisioned worktrees `--fix` repairs.
// ---------------------------------------------------------------------------

const key = (p: string) => resolvePath(p);

// Owned keys = configured port keys plus any keys env.derive emits. derive is a
// user function; call it best-effort (read-only) and ignore a throw.
const ownedKeysFor = (
  config: HomesteadConfig,
  repo: Repo,
  target: Target,
  envContent: string,
): ReadonlyArray<string> => {
  const portKeys = (config.ports ?? []).map((spec) => spec.key);
  if (config.env?.derive === undefined) return portKeys;
  try {
    const ctx = makeWorktreeContext(repo, target, envContent);
    return [...portKeys, ...Object.keys(config.env.derive(ctx))];
  } catch {
    return portKeys;
  }
};

const allKeysPresent = (env: string, keys: ReadonlyArray<string>): boolean =>
  keys.every((k) => {
    const v = readEnvVar(env, k);
    return v !== undefined && v.trim() !== "";
  });

interface WorktreeFacts {
  readonly entry: WorktreePorcelainEntry;
  readonly target: Target;
  readonly label: string;
  readonly hasEnv: boolean;
  readonly env: string;
  readonly provisioning: ProvisioningStatus;
  readonly completedAt: string | undefined;
  readonly tracked: Option.Option<TrackedBranch["state"]>;
  // Owned ports this worktree's `.env` claims, with their live-bound state.
  readonly livePorts: ReadonlyArray<{ readonly key: string; readonly value: string; readonly bound: boolean }>;
  readonly hasLocalWork: boolean;
}

export interface DoctorScan {
  readonly report: DoctorReport;
  // Half-provisioned worktrees `--fix` should re-run setup on (branch known).
  readonly repairs: ReadonlyArray<Target>;
}

export const scanDoctor = Effect.fn("homestead/scan-doctor")(function* (
  repo: Repo,
  config: HomesteadConfig,
  gitWorktreeList: Effect.Effect<ReadonlyArray<WorktreePorcelainEntry>, never, Git> = Git.pipe(
    Effect.flatMap((git) => git.worktree.list(repo.startCwd)),
  ),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git;

  const gitWorktrees = yield* gitWorktreeList.pipe(
    Effect.catchDefect(() => Effect.succeed([] as ReadonlyArray<WorktreePorcelainEntry>)),
  );
  const primary = key(repo.primaryRoot);
  const worktrees = gitWorktrees.filter((e) => key(e.path) !== primary);

  const portKeys = (config.ports ?? []).map((spec) => spec.key);

  // Live worktree dirs (resolved, exist on disk) for the stale-state check.
  const liveDirs = new Set<string>();
  for (const e of gitWorktrees) {
    const exists = yield* fs.exists(e.path).pipe(Effect.orElseSucceed(() => false));
    if (exists) liveDirs.add(key(e.path));
  }

  const facts: Array<WorktreeFacts> = [];
  for (const entry of worktrees) {
    const branch = entry.branch ?? slugify(path.basename(entry.path));
    const target: Target = {
      targetDir: entry.path,
      branch,
      slug: slugify(entry.branch ?? "") || slugify(path.basename(entry.path)),
    };
    const label = entry.branch ?? path.basename(entry.path);

    const envPath = path.join(entry.path, ".env");
    const hasEnv = yield* fs.exists(envPath).pipe(Effect.orElseSucceed(() => false));
    const env = hasEnv
      ? yield* fs.readFileString(envPath).pipe(Effect.orElseSucceed(() => ""))
      : "";

    const marker = yield* readProvisionMarker(entry.path);
    const hasMarker = Option.isSome(marker);
    const ownedKeys = ownedKeysFor(config, repo, target, env);
    const provisioning = classifyProvisioning({
      hasEnv,
      hasMarker,
      ownedKeysPresent: allKeysPresent(env, ownedKeys),
    });

    const tracked = yield* loadTrackingState(repo.repoName, branch);

    // Live-port probe (WARN only): something is listening, but we can't always
    // attribute the socket to this worktree's own dev server.
    const livePorts: Array<{ key: string; value: string; bound: boolean }> = [];
    for (const k of portKeys) {
      const value = readEnvVar(env, k);
      if (value === undefined || value === "") continue;
      const port = Number(value);
      if (!Number.isInteger(port)) continue;
      const bound = yield* probeTcp(PROBE_HOST, port, PROBE_TIMEOUT_MS);
      livePorts.push({ key: k, value, bound });
    }

    // Untracked-work signal (Check 3): only worktrees homestead didn't provision
    // (no marker) and doesn't track. Probe for local work only then — it's the
    // expensive bit and irrelevant for provisioned worktrees.
    let hasLocalWork = false;
    if (!hasMarker && Option.isNone(tracked)) {
      const status = yield* git.statusV2(entry.path).pipe(Effect.catchDefect(() => Effect.succeed("")));
      // Empty output means the probe failed — fail safe (assume work present) so
      // doctor never wrongly implies an untracked worktree is disposable.
      const parsed = status === "" ? { dirty: true, unpushed: true } : parseGitStatus(status);
      hasLocalWork = parsed.dirty || parsed.unpushed;
    }

    facts.push({
      entry,
      target,
      label,
      hasEnv,
      env,
      provisioning,
      completedAt: Option.isSome(marker) ? marker.value.completedAt : undefined,
      tracked,
      livePorts,
      hasLocalWork,
    });
  }

  // Check 2 (deterministic): cross-reference every sibling `.env` per port key.
  const conflicts = detectPortConflicts(
    facts.filter((f) => f.hasEnv).map((f) => ({ label: f.label, env: f.env })),
    portKeys,
  );
  const conflictsByLabel = new Map<string, Array<PortConflict>>();
  for (const c of conflicts) {
    for (const label of c.labels) {
      const list = conflictsByLabel.get(label) ?? [];
      list.push(c);
      conflictsByLabel.set(label, list);
    }
  }

  // Check 4: stale tracking state.
  const stateFiles = yield* listTrackedBranches(repo.repoName);
  const stale = detectStaleState(stateFiles, liveDirs);

  // --- Assemble the report -------------------------------------------------
  const worktreeReports: Array<WorktreeReport> = [];
  const repairs: Array<Target> = [];

  for (const f of facts) {
    const findings: Array<Finding> = [];

    switch (f.provisioning.kind) {
      case "provisioned":
        findings.push({
          severity: "pass",
          message: `provisioned${f.completedAt !== undefined ? ` (setup completed ${f.completedAt.slice(0, 10)})` : ""}`,
        });
        break;
      case "half-provisioned":
        findings.push({
          severity: "fail",
          message:
            ".env present but setup never completed (half-provisioned) — run `homestead doctor --fix`",
        });
        if (f.entry.branch !== undefined) repairs.push(f.target);
        break;
      case "legacy":
        findings.push({
          severity: "warn",
          message:
            "provisioned (legacy: no completion marker — inferred from .env; re-provision to confirm)",
        });
        break;
      case "not-homestead":
        findings.push({ severity: "pass", message: "not homestead-provisioned (no .env / marker)" });
        break;
    }

    // Check 2 deterministic conflicts (FAIL).
    for (const c of conflictsByLabel.get(f.label) ?? []) {
      const others = c.labels.filter((l) => l !== f.label);
      findings.push({
        severity: "fail",
        message: `port conflict: ${c.key}=${c.value} also claimed by ${others.map((o) => `'${o}'`).join(", ")}`,
      });
    }

    // Check 2 live-bound ports (WARN).
    for (const p of f.livePorts) {
      if (!p.bound) continue;
      findings.push({
        severity: "warn",
        message: `${p.key}=${p.value} is in use — if this worktree's server isn't running, another process took it`,
      });
    }

    // Check 3 tracking line.
    if (Option.isSome(f.tracked)) {
      const st = f.tracked.value;
      const detail =
        st.kind === "spawn"
          ? "spawn"
          : st.number !== undefined
            ? `issue #${st.number}`
            : "issue";
      findings.push({ severity: "pass", message: `tracked (${detail})` });
    } else if (f.provisioning.kind === "not-homestead" && f.hasLocalWork) {
      findings.push({
        severity: "warn",
        message:
          "untracked work: homestead didn't provision this and it has uncommitted/unpushed changes — gc & teardown will leave it alone",
      });
    }

    worktreeReports.push({ label: f.label, path: f.entry.path, findings });
  }

  const global: Array<Finding> = stale.map((s) => ({
    severity: "warn",
    message: `stale state: tracking for '${s.branch}' points at a missing worktree — \`homestead gc\` will reclaim it`,
  }));

  return {
    report: { worktrees: worktreeReports, global },
    repairs,
  } satisfies DoctorScan;
});

// ---------------------------------------------------------------------------
// Report — printing + the summary line.
// ---------------------------------------------------------------------------

const symbol = (severity: Severity): string =>
  severity === "pass" ? "✓" : severity === "warn" ? "⚠" : "✗";

const printReport = Effect.fn("homestead/doctor-print")(function* (report: DoctorReport) {
  if (report.worktrees.length === 0 && report.global.length === 0) {
    yield* Console.log("homestead doctor — no non-primary worktrees to audit.");
    return;
  }
  for (const wt of report.worktrees) {
    yield* Console.log(`\n▸ ${wt.label}  (${wt.path})`);
    for (const f of wt.findings) {
      yield* Console.log(`  ${symbol(f.severity)} ${f.message}`);
    }
  }
  for (const f of report.global) {
    yield* Console.log(`\n${symbol(f.severity)} ${f.message}`);
  }

  const fails = countSeverity(report, "fail");
  const warns = countSeverity(report, "warn");
  const n = report.worktrees.length;
  yield* Console.log(
    `\n${n} worktree${n === 1 ? "" : "s"}, ${fails} fail${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}`,
  );
});

// ---------------------------------------------------------------------------
// runDoctor — scan, print, and (with --fix) repair half-provisioned worktrees.
// ---------------------------------------------------------------------------

export const runDoctor = Effect.fn("homestead/run-doctor")(function* (
  repo: Repo,
  config: HomesteadConfig,
  options: { readonly fix: boolean },
) {
  const scan = yield* scanDoctor(repo, config);
  yield* printReport(scan.report);

  if (!options.fix) {
    yield* Effect.sync(() => {
      process.exitCode = hasFailure(scan.report) ? 1 : 0;
    });
    return;
  }

  if (scan.repairs.length === 0) {
    yield* Console.log("\n(--fix: nothing half-provisioned to repair)");
    yield* Effect.sync(() => {
      process.exitCode = hasFailure(scan.report) ? 1 : 0;
    });
    return;
  }

  yield* Console.log(`\n▸ --fix: re-running setup on ${scan.repairs.length} half-provisioned worktree(s)`);
  for (const target of scan.repairs) {
    yield* Console.log(`\n  repairing ${target.branch} (${target.targetDir})`);
    yield* provisionTarget(config, repo, target, {});
  }

  // Re-scan so the exit code reflects the post-repair state.
  yield* Console.log(`\n▸ --fix: re-checking after repair`);
  const after = yield* scanDoctor(repo, config);
  yield* printReport(after.report);
  yield* Effect.sync(() => {
    process.exitCode = hasFailure(after.report) ? 1 : 0;
  });
});
