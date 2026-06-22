import { Effect, FileSystem, Path } from "effect";
import { pathToFileURL } from "node:url";
import { ConfigInvalid, ConfigNotFound } from "./errors.ts";
import type { GithogConfig } from "./types.ts";

const CONFIG_BASENAMES = ["githog.config.ts", "githog.config.js", "githog.config.mjs"] as const;

// How the user's TypeScript config crosses the dynamic-import boundary WITHOUT a
// cast: defineConfig is a typed identity that also stashes its argument here.
// Loading the config file evaluates `export default defineConfig({...})`, whose
// side effect lands the already-`GithogConfig`-typed value in `registered`. We
// then read it back fully typed — no `as`, no asserting an `unknown` import.
let registered: GithogConfig | undefined;

export const defineConfig = (config: GithogConfig): GithogConfig => {
  registered = config;
  return config;
};

// The trust boundary for a config authored as a plain `export default { ... }`
// (no `githog` import needed — handy in repos where the package isn't resolvable).
// A config file is the user's own typed code, not untrusted serialized data, so a
// type guard at this single seam is the honest narrowing: we confirm it's an
// object and trust the function/field shapes (validate() still checks the data).
const isConfigObject = (value: unknown): value is GithogConfig =>
  typeof value === "object" && value !== null;

const defaultExport = (mod: unknown): GithogConfig | undefined => {
  if (typeof mod !== "object" || mod === null || !("default" in mod)) return undefined;
  return isConfigObject(mod.default) ? mod.default : undefined;
};

// --- runtime validation of the serializable surface ------------------------
// Functions are trusted via defineConfig's typing; the data we still check here
// is what a slip past the type-checker (or a hand-written JS config) could break.

const validate = (config: GithogConfig): Effect.Effect<GithogConfig, ConfigInvalid> =>
  Effect.gen(function* () {
    for (const [i, port] of (config.ports ?? []).entries()) {
      if (!Number.isInteger(port.base) || port.base < 0) {
        return yield* new ConfigInvalid({
          path: `ports[${i}].base`,
          reason: `must be a non-negative integer, got ${String(port.base)}`,
        });
      }
      if (port.key.trim() === "") {
        return yield* new ConfigInvalid({ path: `ports[${i}].key`, reason: "must be a non-empty env key" });
      }
    }
    for (const [i, service] of (config.services ?? []).entries()) {
      if (!Number.isInteger(service.port) || service.port <= 0) {
        return yield* new ConfigInvalid({
          path: `services[${i}].port`,
          reason: `must be a positive integer, got ${String(service.port)}`,
        });
      }
    }
    for (const [i, step] of (config.setup ?? []).entries()) {
      if (step.run.length === 0) {
        return yield* new ConfigInvalid({ path: `setup[${i}].run`, reason: "must be a non-empty argv array" });
      }
    }
    return config;
  });

// Walk up from `startDir` to the filesystem root looking for a githog config
// file, import it, and hand back the registered config. Mirrors how worktree
// tooling finds the primary checkout — config lives at the repo root.
export const loadConfig = Effect.fn("githog/load-config")(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let dir = path.resolve(startDir);
  for (;;) {
    for (const base of CONFIG_BASENAMES) {
      const candidate = path.join(dir, base);
      if (yield* fs.exists(candidate)) {
        registered = undefined;
        const mod: unknown = yield* Effect.tryPromise({
          try: () => import(pathToFileURL(candidate).href),
          catch: (cause) =>
            new ConfigInvalid({ path: candidate, reason: `failed to import: ${String(cause)}` }),
        });
        // Prefer the defineConfig registry (type-safe); fall back to a plain
        // `export default { ... }` so a config needs no githog import.
        const config = registered ?? defaultExport(mod);
        if (config === undefined) {
          return yield* new ConfigInvalid({
            path: candidate,
            reason: "exported no config — use `export default defineConfig({ ... })` or `export default { ... }`",
          });
        }
        return yield* validate(config);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return yield* new ConfigNotFound({
        searchedFrom: startDir,
        detail: `no ${CONFIG_BASENAMES.join(" / ")} found from ${startDir} up to the filesystem root`,
      });
    }
    dir = parent;
  }
});
