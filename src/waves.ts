import { Data } from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// Pure wave scheduler. ZERO IO imports by design (acceptance criterion): this
// file is unit-tested without git / gh / fs. The IO shell that fetches issue
// bodies and wires the `homestead plan` command lives in src/waves-cmd.ts.
//
// The one spine: parallelism is bounded by SHARED FILES, not by logical
// independence. Two issues build in parallel only when neither depends on the
// other AND they touch no common source path. `depends-on` decides order;
// `touches` decides how wide each dependency layer can fan out.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedIssue {
  readonly number: number;
  readonly title: string;
  readonly touches: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
}

export interface WaveEntry {
  readonly number: number;
  readonly title: string;
}

export interface Wave {
  readonly index: number;
  readonly build: ReadonlyArray<WaveEntry>;
  // Resolved issue numbers this wave's members depend on (always in an earlier
  // wave). Human-only annotation; omitted from the JSON shape.
  readonly waitsOn: ReadonlyArray<number>;
}

export interface WaveSchedule {
  readonly waves: ReadonlyArray<Wave>;
  readonly integrate: ReadonlyArray<number>;
  readonly warnings: ReadonlyArray<string>;
}

// Thrown by planWaves for the two fail-loud cases: a depends-on title that
// matches no issue in the set, or a dependency cycle. A missed edge is a wrong
// integrate order — the most expensive failure mode — so we never silently drop.
export class WavePlanError extends Data.TaggedError("WavePlanError")<{
  readonly reason: "dangling-dependency" | "cycle";
  readonly message: string;
}> {}

// ─────────────────────────────────────────────────────────────────────────────
// parseWaveMetadata
// ─────────────────────────────────────────────────────────────────────────────

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

// Split a `key: a, b, c  # comment` value list: drop the trailing comment, split
// on commas, trim, drop empties, normalize a lone `none` to [].
const parseList = (value: string): Array<string> => {
  const hash = value.indexOf("#");
  const body = hash === -1 ? value : value.slice(0, hash);
  const items = body
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 1 && items[0]?.toLowerCase() === "none") return [];
  return items;
};

const lineValue = (block: string, key: string): string | undefined => {
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith(`${key}:`)) {
      return line.slice(line.indexOf(":") + 1);
    }
  }
  return undefined;
};

/**
 * Extract the `touches:` / `depends-on:` metadata from an issue body. The block
 * is the first fenced ``` ``` ``` section that carries a `touches:` line (the
 * issue body also contains unrelated fenced blocks — CLI examples, etc.). A
 * missing block yields empty arrays.
 */
export const parseWaveMetadata = (
  body: string,
): { touches: Array<string>; dependsOn: Array<string> } => {
  FENCE.lastIndex = 0;
  let block: string | undefined;
  for (let m = FENCE.exec(body); m !== null; m = FENCE.exec(body)) {
    const inner = m[1] ?? "";
    if (/^[ \t]*touches[ \t]*:/im.test(inner)) {
      block = inner;
      break;
    }
  }
  if (block === undefined) return { touches: [], dependsOn: [] };

  const touchesRaw = lineValue(block, "touches");
  const dependsRaw = lineValue(block, "depends-on");
  return {
    touches: touchesRaw === undefined ? [] : parseList(touchesRaw),
    dependsOn: dependsRaw === undefined ? [] : parseList(dependsRaw),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// planWaves
// ─────────────────────────────────────────────────────────────────────────────

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

const uniqueSorted = (ns: ReadonlyArray<number>): Array<number> =>
  [...new Set(ns)].sort((a, b) => a - b);

/**
 * Turn a set of issues into collision-aware build waves plus a single serial
 * integrate order. Pure and deterministic: same input ⇒ identical output.
 *
 * Throws WavePlanError on an unresolvable depends-on title or a dependency cycle.
 */
export const planWaves = (issues: ReadonlyArray<ParsedIssue>): WaveSchedule => {
  const byNumber = new Map<number, ParsedIssue>();
  const titleToNumber = new Map<string, number>();
  for (const issue of issues) {
    byNumber.set(issue.number, issue);
    titleToNumber.set(normalizeTitle(issue.title), issue.number);
  }

  // 1. Resolve depends-on titles → numbers (fail loud on a dangling title).
  const deps = new Map<number, Array<number>>();
  for (const issue of issues) {
    const resolved: Array<number> = [];
    for (const title of issue.dependsOn) {
      const target = titleToNumber.get(normalizeTitle(title));
      if (target === undefined) {
        throw new WavePlanError({
          reason: "dangling-dependency",
          message: `#${issue.number} depends-on "${title}", which matches no issue in the set`,
        });
      }
      if (target !== issue.number) resolved.push(target);
    }
    deps.set(issue.number, uniqueSorted(resolved));
  }

  // 2. Layer by dependency depth via DFS (longest path to a root). The visiting
  //    set turns any back-edge into a fail-loud cycle.
  const layer = new Map<number, number>();
  const visiting = new Set<number>();
  const layerOf = (n: number): number => {
    const cached = layer.get(n);
    if (cached !== undefined) return cached;
    if (visiting.has(n)) {
      throw new WavePlanError({
        reason: "cycle",
        message: `dependency cycle involving #${n}`,
      });
    }
    visiting.add(n);
    const myDeps = deps.get(n) ?? [];
    const value = myDeps.length === 0 ? 0 : Math.max(...myDeps.map(layerOf)) + 1;
    visiting.delete(n);
    layer.set(n, value);
    return value;
  };
  for (const issue of issues) layerOf(issue.number);

  // 3. Within each dependency layer, greedily first-fit issues into batches that
  //    share no `touches` file. An issue with no declared touches "collides with
  //    everything" and is isolated into its own batch (the clean-merge-that-wasn't
  //    failure mode: serialize the unknown rather than optimistically parallelize).
  const layerIndices = uniqueSorted([...layer.values()]);
  const waves: Array<Wave> = [];
  let waveIndex = 0;
  for (const li of layerIndices) {
    const members = issues
      .filter((i) => layer.get(i.number) === li)
      .sort((a, b) => a.number - b.number);

    const batches: Array<{ files: Set<string>; sealed: boolean; members: Array<ParsedIssue> }> = [];
    for (const issue of members) {
      if (issue.touches.length === 0) {
        batches.push({ files: new Set(), sealed: true, members: [issue] });
        continue;
      }
      const fit = batches.find(
        (b) => !b.sealed && !issue.touches.some((f) => b.files.has(f)),
      );
      if (fit === undefined) {
        batches.push({
          files: new Set(issue.touches),
          sealed: false,
          members: [issue],
        });
      } else {
        for (const f of issue.touches) fit.files.add(f);
        fit.members.push(issue);
      }
    }

    for (const batch of batches) {
      waveIndex += 1;
      const sorted = batch.members.slice().sort((a, b) => a.number - b.number);
      const waitsOn = uniqueSorted(sorted.flatMap((m) => deps.get(m.number) ?? []));
      waves.push({
        index: waveIndex,
        build: sorted.map((m) => ({ number: m.number, title: m.title })),
        waitsOn,
      });
    }
  }

  // 4. Integrate order: one serial sequence respecting every dependency edge,
  //    tie-broken by the lowest issue number (Kahn's algorithm, min-number pick).
  const integrate = topoSortByNumber(issues, deps);

  // 5. Warnings: one per undeclared-touches issue, lowest number first.
  const warnings = issues
    .filter((i) => i.touches.length === 0)
    .sort((a, b) => a.number - b.number)
    .map((i) => `#${i.number} declares no touches:`);

  return { waves, integrate, warnings };
};

const topoSortByNumber = (
  issues: ReadonlyArray<ParsedIssue>,
  deps: ReadonlyMap<number, ReadonlyArray<number>>,
): Array<number> => {
  const emitted = new Set<number>();
  const order: Array<number> = [];
  const all = issues.map((i) => i.number).sort((a, b) => a - b);
  while (order.length < all.length) {
    const next = all.find(
      (n) => !emitted.has(n) && (deps.get(n) ?? []).every((d) => emitted.has(d)),
    );
    // Cycles are already rejected by layerOf, so a ready node always exists here.
    if (next === undefined) break;
    emitted.add(next);
    order.push(next);
  }
  return order;
};

// ─────────────────────────────────────────────────────────────────────────────
// Renderers (pure string formatting — no IO)
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable schedule, matching the documented CLI surface. */
export const renderHuman = (schedule: WaveSchedule): string => {
  const lines: Array<string> = [];
  for (const wave of schedule.waves) {
    const build = wave.build.map((e) => `#${e.number} ${e.title}`).join(", ");
    const waits = wave.waitsOn.length === 0
      ? ""
      : `  [waits on ${wave.waitsOn.map((n) => `#${n}`).join(", ")}]`;
    lines.push(`Wave ${wave.index} (build in parallel): ${build}${waits}`);
  }
  lines.push(
    `Integrate (serial, gate green each): ${schedule.integrate.map((n) => `#${n}`).join(" → ")}`,
  );
  for (const warning of schedule.warnings) {
    lines.push(`⚠ ${warning} — scheduled alone for safety`);
  }
  return lines.join("\n");
};

/**
 * Machine shape for the MCP planner tool + skills. Built explicitly (not a raw
 * stringify of WaveSchedule) so internal fields like `waitsOn` never leak — the
 * `--json` contract is exactly { waves, integrate, warnings }.
 */
export const renderJson = (schedule: WaveSchedule): string =>
  JSON.stringify(
    {
      waves: schedule.waves.map((w) => ({
        index: w.index,
        build: w.build.map((e) => ({ number: e.number, title: e.title })),
      })),
      integrate: schedule.integrate,
      warnings: schedule.warnings,
    },
    null,
    2,
  );
