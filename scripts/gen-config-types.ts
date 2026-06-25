#!/usr/bin/env bun
// Generate a self-contained, effect-free `homestead.config.types.d.ts` from the
// real `HomesteadConfig` type in src/types.ts. This is the file `homestead init`
// drops into a consumer repo so a homestead.config.ts can be fully typed with
// NOTHING installed — no `homestead` dependency, no `effect`, no bloat.
//
// Single source of truth: we resolve HomesteadConfig via the TypeScript checker
// and print each property structurally, so schema/type changes flow through on
// the next release. Members that reference effect (lifecycle hooks, onEvent)
// are loosened to effect-free shapes consumers can implement synchronously.
//
//   bun run scripts/gen-config-types.ts            # -> src/homestead.config.types.d.ts
//   bun run scripts/gen-config-types.ts --check    # fail if out of date (CI/release)

import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const typesEntry = join(root, "src", "types.ts");
const outPath = join(root, "src", "generated", "homestead.config.types.d.ts");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

// Lifecycle hooks and onEvent touch `effect` (Effect + HomesteadServices). Consumers
// rarely need the full runtime type and a bare .d.ts has no `effect` to import,
// so we loosen them to unknown-returning callbacks.
const EFFECT_FREE_HOOKS: Record<string, string> = {
  afterSetup: "afterSetup?: ((ctx: WorktreeContext & { readonly plan: Plan }) => unknown) | undefined",
  afterLaunch: "afterLaunch?: ((ctx: HomesteadContext & { readonly paneId: string; }) => unknown) | undefined",
  beforeTeardown:
    'beforeTeardown?: ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly tracked: boolean; }) => unknown) | undefined',
  afterTeardown:
    'afterTeardown?: ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly reviewLabel?: string; }) => unknown) | undefined',
  onEvent: "onEvent?: ((e: HomesteadEvent) => unknown) | undefined",
};

const PR_VIEW = `export interface PrView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isCrossRepository: boolean;
}`;

const HOMESTEAD_EVENT = `export type HomesteadEvent =
  | { type: "worktree.creating"; branch: string; targetDir: string; from?: string }
  | {
      type: "agent.launching" | "agent.launched";
      item: WorkItem;
      command: ReadonlyArray<string>;
      paneId?: string;
      worktreeDir: string;
    }
  | {
      type: "pr.launching" | "pr.launched";
      pr: PrView;
      mode: "review" | "work";
      branch: string;
      paneId?: string;
    }
  | { type: "issues.summary"; launched: number; total: number }
  | {
      type: "teardown";
      verb: "kill" | "close" | "complete";
      branch: string;
      phase: "start" | "done";
      reviewLabel?: string;
    };`;

const program = ts.createProgram([typesEntry], {
  strict: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(typesEntry);
if (!source) throw new Error(`cannot load ${typesEntry}`);

const exportsOfFile = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
const findExport = (name: string) => {
  const sym = exportsOfFile.find((s) => s.name === name);
  if (!sym) throw new Error(`expected export "${name}" in src/types.ts`);
  return sym;
};

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

// Print one exported type as a structural interface body. We expand the type's
// own properties (not nested named types — those stay inlined, which is fine
// for a generated artifact) and never recurse into effect.
const printInterface = (name: string, opts: { effectFreeHooks?: boolean } = {}): string => {
  const sym = findExport(name);
  const type = checker.getDeclaredTypeOfSymbol(sym);
  const props = checker.getPropertiesOfType(type);
  const lines: string[] = [];
  for (const prop of props) {
    const override = opts.effectFreeHooks ? EFFECT_FREE_HOOKS[prop.name] : undefined;
    if (override !== undefined) {
      lines.push(`  readonly ${override};`);
      continue;
    }
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl ?? source);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const printed = checker.typeToString(propType, decl, FLAGS);
    lines.push(`  readonly ${prop.name}${optional ? "?" : ""}: ${printed};`);
  }
  return `export interface ${name} {\n${lines.join("\n")}\n}`;
};

// The named types reachable from HomesteadConfig that consumers may reference,
// plus the context types used by hook signatures. All are effect-free.
// Order matters: WorkItem + PrView before HomesteadContext; HomesteadContext
// before members that reference it; HomesteadEvent before HomesteadConfig.
const NAMED = [
  "WorkItem",
  "HomesteadContext",
  "PortSpec",
  "ServiceSpec",
  "SetupStep",
  "WorktreeContext",
  "AgentPromptContext",
  "TrackingContext",
  "PrPromptContext",
  "Plan",
  "EnvConfig",
  "AgentConfig",
  "IssuesConfig",
  "PrConfig",
];

const blocks = [
  printInterface("WorkItem"),
  PR_VIEW,
  ...NAMED.filter((n) => n !== "WorkItem").map((n) => printInterface(n)),
  HOMESTEAD_EVENT,
  printInterface("HomesteadConfig", { effectFreeHooks: true }),
];

const header = `// AUTO-GENERATED by homestead — do not edit.
// homestead-version: ${pkgVersion}
//
// Self-contained types for authoring a homestead.config.ts. No imports, no
// dependencies. Re-run \`homestead init\` after upgrading homestead to refresh.
//
// Usage in homestead.config.ts:
//   import type { HomesteadConfig } from "./homestead.config.types";
//   const config: HomesteadConfig = { /* ... */ };
//   export default config;
`;

const output = `${header}\n${blocks.join("\n\n")}\n`;

if (process.argv.includes("--check")) {
  // Compare structure only — the version stamp legitimately lags by one release
  // (release.sh re-stamps and amends after the version bump).
  const stripVersion = (s: string) => s.replace(/^\/\/ homestead-version: .*$/m, "");
  const current = (() => {
    try {
      return readFileSync(outPath, "utf8");
    } catch {
      return "";
    }
  })();
  if (stripVersion(current) !== stripVersion(output)) {
    console.error("homestead.config.types.d.ts is out of date — run: bun run scripts/gen-config-types.ts");
    process.exit(1);
  }
  console.log("homestead.config.types.d.ts is up to date");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath}`);
}
