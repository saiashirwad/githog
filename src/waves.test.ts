import { expect, test } from "bun:test";
import {
  parseWaveMetadata,
  planWaves,
  renderHuman,
  renderJson,
  WavePlanError,
  type ParsedIssue,
} from "./waves.ts";

// ── parseWaveMetadata ────────────────────────────────────────────────────────

test("parseWaveMetadata extracts a well-formed fenced block", () => {
  const body = [
    "Some intro prose.",
    "",
    "```",
    "touches: src/waves.ts, src/cli.ts",
    "depends-on: agent wait, tracking kind",
    "```",
    "",
    "More prose.",
  ].join("\n");
  expect(parseWaveMetadata(body)).toEqual({
    touches: ["src/waves.ts", "src/cli.ts"],
    dependsOn: ["agent wait", "tracking kind"],
  });
});

test("parseWaveMetadata normalizes `none` to empty arrays", () => {
  const body = "```\ntouches: src/waves.ts\ndepends-on: none\n```";
  expect(parseWaveMetadata(body)).toEqual({ touches: ["src/waves.ts"], dependsOn: [] });
});

test("parseWaveMetadata strips trailing # comments and extra whitespace", () => {
  const body = "```\ntouches:   src/a.ts ,  src/b.ts   # the files\ndepends-on:  none  # nothing\n```";
  expect(parseWaveMetadata(body)).toEqual({ touches: ["src/a.ts", "src/b.ts"], dependsOn: [] });
});

test("parseWaveMetadata returns empty arrays for a missing block", () => {
  expect(parseWaveMetadata("no metadata here at all")).toEqual({ touches: [], dependsOn: [] });
});

test("parseWaveMetadata skips unrelated fenced blocks and picks the metadata one", () => {
  const body = [
    "```bash",
    "$ homestead plan 1 2 3",
    "```",
    "",
    "```",
    "touches: src/x.ts",
    "depends-on: none",
    "```",
  ].join("\n");
  expect(parseWaveMetadata(body)).toEqual({ touches: ["src/x.ts"], dependsOn: [] });
});

// ── planWaves: collision / independence ──────────────────────────────────────

const issue = (
  number: number,
  title: string,
  touches: Array<string>,
  dependsOn: Array<string> = [],
): ParsedIssue => ({ number, title, touches, dependsOn });

test("planWaves never co-schedules two issues sharing a touches path", () => {
  const { waves } = planWaves([
    issue(1, "a", ["src/cli.ts"]),
    issue(2, "b", ["src/cli.ts"]),
  ]);
  // Same dependency layer, but a shared file ⇒ two separate waves.
  expect(waves).toHaveLength(2);
  expect(waves[0]!.build.map((e) => e.number)).toEqual([1]);
  expect(waves[1]!.build.map((e) => e.number)).toEqual([2]);
});

test("planWaves packs disjoint-touches issues into one wave", () => {
  const { waves } = planWaves([
    issue(1, "a", ["src/a.ts"]),
    issue(2, "b", ["src/b.ts"]),
    issue(3, "c", ["src/c.ts"]),
  ]);
  expect(waves).toHaveLength(1);
  expect(waves[0]!.build.map((e) => e.number)).toEqual([1, 2, 3]);
});

// ── planWaves: dependencies ──────────────────────────────────────────────────

test("planWaves orders a dependent issue after its target", () => {
  const { waves, integrate } = planWaves([
    issue(1, "A", ["src/a.ts"]),
    issue(2, "B", ["src/b.ts"], ["A"]),
  ]);
  expect(waves[0]!.build.map((e) => e.number)).toEqual([1]);
  expect(waves[1]!.build.map((e) => e.number)).toEqual([2]);
  expect(waves[1]!.waitsOn).toEqual([1]);
  expect(integrate).toEqual([1, 2]);
});

test("planWaves layers a diamond correctly", () => {
  // A ; B,C depend-on A ; D depends-on B,C
  const { waves, integrate } = planWaves([
    issue(1, "A", ["src/a.ts"]),
    issue(2, "B", ["src/b.ts"], ["A"]),
    issue(3, "C", ["src/c.ts"], ["A"]),
    issue(4, "D", ["src/d.ts"], ["B", "C"]),
  ]);
  expect(waves).toHaveLength(3);
  expect(waves[0]!.build.map((e) => e.number)).toEqual([1]);
  expect(waves[1]!.build.map((e) => e.number)).toEqual([2, 3]); // same layer, disjoint files
  expect(waves[1]!.waitsOn).toEqual([1]);
  expect(waves[2]!.build.map((e) => e.number)).toEqual([4]);
  expect(waves[2]!.waitsOn).toEqual([2, 3]);
  expect(integrate).toEqual([1, 2, 3, 4]);
});

// ── planWaves: fail-loud edges ───────────────────────────────────────────────

test("planWaves rejects a dangling depends-on title", () => {
  expect(() => planWaves([issue(1, "A", ["src/a.ts"], ["does not exist"])])).toThrow(WavePlanError);
  try {
    planWaves([issue(1, "A", ["src/a.ts"], ["does not exist"])]);
  } catch (e) {
    expect((e as WavePlanError).reason).toBe("dangling-dependency");
    expect((e as WavePlanError).message).toContain("#1");
    expect((e as WavePlanError).message).toContain("does not exist");
  }
});

test("planWaves rejects a dependency cycle", () => {
  expect(() =>
    planWaves([
      issue(1, "A", ["src/a.ts"], ["B"]),
      issue(2, "B", ["src/b.ts"], ["A"]),
    ]),
  ).toThrow(WavePlanError);
  try {
    planWaves([
      issue(1, "A", ["src/a.ts"], ["B"]),
      issue(2, "B", ["src/b.ts"], ["A"]),
    ]);
  } catch (e) {
    expect((e as WavePlanError).reason).toBe("cycle");
  }
});

// ── planWaves: undeclared touches ────────────────────────────────────────────

test("planWaves isolates an undeclared-touches issue and warns", () => {
  const { waves, warnings } = planWaves([
    issue(1, "a", ["src/a.ts"]),
    issue(2, "b", ["src/b.ts"]),
    issue(3, "noTouches", []),
  ]);
  // 1 and 2 share a layer & no files ⇒ one wave; 3 is isolated into its own.
  const waveOf = (n: number) => waves.find((w) => w.build.some((e) => e.number === n))!.index;
  expect(waveOf(1)).toBe(waveOf(2));
  expect(waveOf(3)).not.toBe(waveOf(1));
  expect(warnings).toEqual(["#3 declares no touches:"]);
});

test("two undeclared-touches issues never share a wave", () => {
  const { waves } = planWaves([issue(1, "a", []), issue(2, "b", [])]);
  expect(waves).toHaveLength(2);
});

// ── determinism ──────────────────────────────────────────────────────────────

test("planWaves is deterministic across runs and input ordering", () => {
  const issues = [
    issue(4, "D", ["src/d.ts"], ["B", "C"]),
    issue(2, "B", ["src/b.ts"], ["A"]),
    issue(1, "A", ["src/a.ts"]),
    issue(3, "C", ["src/c.ts"], ["A"]),
  ];
  const first = renderJson(planWaves(issues));
  const second = renderJson(planWaves([...issues].reverse()));
  expect(first).toBe(second);
});

// ── renderers ────────────────────────────────────────────────────────────────

test("renderHuman matches the documented surface", () => {
  const schedule = planWaves([
    issue(28, "agent wait", ["src/agent/wait.ts"]),
    issue(31, "tracking kind", ["src/tracking.ts"]),
    issue(32, "ls dashboard", ["src/dashboard.ts"], ["agent wait"]),
    issue(43, "issue --from", []),
  ]);
  const text = renderHuman(schedule);
  expect(text).toContain("Wave 1 (build in parallel): #28 agent wait, #31 tracking kind");
  expect(text).toContain("[waits on #28]");
  expect(text).toContain("Integrate (serial, gate green each): #28 → #31 → #32 → #43");
  expect(text).toContain("⚠ #43 declares no touches: — scheduled alone for safety");
});

test("renderJson emits exactly { waves, integrate, warnings }", () => {
  const schedule = planWaves([issue(1, "a", []), issue(2, "b", ["src/b.ts"], ["a"])]);
  const parsed = JSON.parse(renderJson(schedule));
  expect(Object.keys(parsed).sort()).toEqual(["integrate", "warnings", "waves"]);
  // No internal fields (e.g. waitsOn) leak into the build entries.
  expect(Object.keys(parsed.waves[0])).toEqual(["index", "build"]);
  expect(Object.keys(parsed.waves[0]!.build[0]).sort()).toEqual(["number", "title"]);
});
