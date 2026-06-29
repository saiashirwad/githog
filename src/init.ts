import { Console, Effect, FileSystem, Path } from "effect";

// The starter config types itself against the local `homestead.config.types.d.ts`
// (written below) rather than importing from "homestead", so a consumer repo needs
// NOTHING installed — no homestead dependency, no effect, no bloat. The CLI loads
// the config by reading its default export.
const STARTER_CONFIG = `import type { HomesteadConfig } from "./generated/homestead.config.types";

export default {
  // Per-worktree ports (omit if this repo isn't a server):
  // ports: [{ key: "PORT", base: 3000 }],

  setup: [{ label: "install", run: ["bun", "install"] }],

  issues: { label: "agent:wip", assign: true, comment: true },

  agent: {
    command: ["claude"],
    surface: "worktree",
  },
} satisfies HomesteadConfig;
`;

// The generated, effect-free types ship inside the package (src/ is in "files").
const BUNDLED_CONFIG_TYPES = `${import.meta.dirname}/generated/homestead.config.types.d.ts`;
// In the target repo the generated types land in a `generated/` folder so they
// don't clutter the project root; the starter config imports them from there.
const CONFIG_TYPES_RELPATH = ["generated", "homestead.config.types.d.ts"] as const;

// Bundled Claude Code skills live next to this file (src/skills/*), so they
// ship with the package (src/ is already in package.json "files").
const BUNDLED_SKILLS_DIR = `${import.meta.dirname}/skills`;

/**
 * Copy each bundled skill into <repo>/.claude/skills/<name>/, idempotently:
 * an already-present skill directory is left untouched so user edits are never
 * clobbered (mirrors how we skip an existing config). Returns the number of
 * skills freshly installed this run.
 */
const installSkills = Effect.fn("homestead/init/skills")(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const bundleExists = yield* fs.exists(BUNDLED_SKILLS_DIR).pipe(Effect.orDie);
  if (!bundleExists) return 0;

  const entries = yield* fs.readDirectory(BUNDLED_SKILLS_DIR).pipe(Effect.orDie);
  const skillsRoot = path.join(primaryRoot, ".claude", "skills");

  let installed = 0;
  for (const name of entries) {
    const source = path.join(BUNDLED_SKILLS_DIR, name);
    const isDir = yield* fs.stat(source).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orDie,
    );
    if (!isDir) continue;

    const target = path.join(skillsRoot, name);
    const alreadyThere = yield* fs.exists(target).pipe(Effect.orDie);
    if (alreadyThere) {
      yield* Console.log(`  • skill ${name} already present — leaving it`);
      continue;
    }

    yield* fs.makeDirectory(skillsRoot, { recursive: true }).pipe(Effect.orDie);
    yield* fs.copy(source, target).pipe(Effect.orDie);
    yield* Console.log(`  ✓ installed skill ${name}`);
    installed += 1;
  }

  if (installed > 0) {
    yield* Console.log(
      `  ✓ installed ${installed} Claude skill${installed === 1 ? "" : "s"} — ask Claude to "set up homestead"`,
    );
  }

  return installed;
});

// Ensure `.homestead/` is gitignored. Each worktree writes runtime state there
// (the provisioning marker, the agent-status sentinel) that must never be
// committed — same treatment `.env` already gets. Idempotent: appends the entry
// only when absent, and creates `.gitignore` if the repo has none.
const ensureHomesteadGitignored = Effect.fn("homestead/init/gitignore")(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ENTRY = ".homestead/";
  const gitignorePath = path.join(primaryRoot, ".gitignore");

  const exists = yield* fs.exists(gitignorePath).pipe(Effect.orDie);
  const current = exists ? yield* fs.readFileString(gitignorePath).pipe(Effect.orDie) : "";

  const alreadyIgnored = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ENTRY || line === ".homestead");
  if (alreadyIgnored) {
    yield* Console.log(`  • ${ENTRY} already gitignored — leaving it`);
    return;
  }

  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  const block = `${prefix}\n# homestead worktree-local runtime state (marker, agent sentinel)\n${ENTRY}\n`;
  yield* fs.writeFileString(gitignorePath, block).pipe(Effect.orDie);
  yield* Console.log(`  ✓ added ${ENTRY} to .gitignore`);
});

export const initRepo = Effect.fn("homestead/init")(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Console.log(`\n▸ homestead init in ${primaryRoot}`);

  const configPath = path.join(primaryRoot, "homestead.config.ts");
  const hasConfig = yield* fs.exists(configPath).pipe(Effect.orDie);
  if (hasConfig) {
    yield* Console.log(`  • homestead.config.ts already exists — leaving it`);
  } else {
    yield* fs.writeFileString(configPath, STARTER_CONFIG).pipe(Effect.orDie);
    yield* Console.log(`  ✓ wrote starter homestead.config.ts`);
  }

  // Always (re)write the generated types so they track the installed homestead
  // version — this file is owned by homestead, not the user, so clobbering is
  // intended (mirrors how an upgrade should refresh the type surface).
  const typesPath = path.join(primaryRoot, ...CONFIG_TYPES_RELPATH);
  const typesBundleExists = yield* fs.exists(BUNDLED_CONFIG_TYPES).pipe(Effect.orDie);
  if (typesBundleExists) {
    const types = yield* fs.readFileString(BUNDLED_CONFIG_TYPES).pipe(Effect.orDie);
    yield* fs.makeDirectory(path.dirname(typesPath), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(typesPath, types).pipe(Effect.orDie);
    yield* Console.log(`  ✓ wrote ${CONFIG_TYPES_RELPATH.join("/")}`);
  }

  yield* ensureHomesteadGitignored(primaryRoot);

  yield* installSkills(primaryRoot);

  yield* Console.log(`\n✅ homestead init done — edit homestead.config.ts, then: homestead issue <issue>`);
});
