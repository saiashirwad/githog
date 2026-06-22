# githog

**Config-driven git-worktree + agent provisioning.** Built on [Effect](https://effect.website) (v4) and [Bun](https://bun.sh).

githog gives every git worktree its own isolated dev environment — its own ports, its own database, its own `.env` — and can fan a batch of GitHub issues out into parallel coding agents, each in its own worktree. One small `githog.config.ts` per project describes how to provision a worktree; githog does the rest.

```bash
githog setup --create my-feature        # isolate a new worktree (ports, .env, services, setup)
githog implement-issues 21 22 23         # one worktree + agent per issue, in parallel
githog kill my-feature                   # remove the worktree, branch, and agent surface
```

## Why

Multiple worktrees of one repo usually collide: they share a database, they fight over dev ports (`3000`, `5173`, …), and each needs its `.env` set up by hand. githog carves out a per-worktree slice — a database named for the branch, the next free ports, a copied-and-rewritten `.env` — so any number of worktrees (and the agents working in them) run side by side without stepping on each other.

The two halves compose: `implement-issues` calls the same worktree provisioning in-process (one Effect graph, no nested shell-outs) and then attaches an agent to each resolved worktree.

## Install

```bash
git clone https://github.com/<you>/githog
cd githog
bun install        # also clones the Effect source into .repos/effect (for the effect-ts dev workflow)
bun link           # puts a `githog` binary on your PATH (~/.bun/bin)
```

The bin is a live symlink to the source, so a `git pull` updates it with no rebuild.

**Runtime prerequisites** (per command):

- `git` — always
- `gh` (authenticated) — for `implement-issues`
- a herdr terminal session — for `implement-issues` and the herdr side of `kill`

## Configure

Each project that uses githog has a `githog.config.ts` at its repo root. See [`githog.config.example.ts`](./githog.config.example.ts) for a fully-worked, copy-pasteable example.

```ts
import { defineConfig } from "githog";

export default defineConfig({
  // env keys made unique per worktree (scans sibling worktrees, takes the lowest free value ≥ base)
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  env: {
    source: ".env",          // copied from the primary checkout (default ".env")
    fallback: ".env.example", // used only if source is missing
    // per-worktree derived keys — `slug` is the branch name slugified, `env` reads the source .env
    derive: ({ slug, env }) => ({
      DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT_DB_URL, `myapp_${slug}`),
    }),
  },

  // TCP dependencies probed before setup; started via `start` if down
  services: [
    { name: "postgres", host: "localhost", port: 5432, start: ["docker", "compose", "up", "-d", "db"] },
  ],

  // ordered provisioning commands run in the new worktree
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
    { label: "seed", run: ["bun", "run", "db:seed"], injectEnv: ["DATABASE_URL"], fatal: false },
  ],

  // implement-issues: what to launch and what to type
  agent: {
    prompt: (item) => `/implement ${item.url}`,
  },
});
```

| Field | What it controls |
| --- | --- |
| `ports` | env keys made unique per worktree by scanning every sibling worktree's `.env` and taking the lowest free value ≥ `base`. |
| `env.source` / `env.fallback` | which `.env` body to copy from the primary checkout (default `.env`, falling back to `.env.example`). |
| `env.derive` | function returning per-worktree key overrides (e.g. a DB name keyed off the branch `slug`). |
| `services` | TCP dependencies probed before setup; if unreachable, `start` is run and githog polls until it's up. |
| `setup` | ordered commands. Tokens `{{slug}}`, `{{branch}}`, `{{targetDir}}`, `{{env:KEY}}` are substituted; `injectEnv` puts computed-env values in the child's environment (beating any baked-in `--env-file`); `fatal: false` warns-and-continues. |
| `agent` | `command` (default `["claude"]`), `surface` (`"worktree"` nests under the repo, `"workspace"`, or `"tab"`), `readyMarker`/`readyTimeoutMs`, and the initial `prompt(item)`. |
| `worktreeDir` | where new worktrees land (default `~/worktrees/<repo>/<slug>`). |
| `issues.branch` | branch name per issue (default the issue number). |
| `afterSetup` | an Effect escape hatch for arbitrary provisioning, with the full Bun platform (`FileSystem`, `Path`, subprocess) in scope. |

A config can also be a plain `export default { ... }` (no `githog` import) when the package isn't resolvable from the repo — handy in projects on a different package manager.

## Commands

### `githog setup`

Provision/isolate one worktree.

```bash
githog setup                              # isolate the worktree you're standing in
githog setup --create my-feature          # create a new worktree on `my-feature`, then isolate it
githog setup --create my-feature --from main --dir ~/wt/x
githog setup --create my-feature --no-setup   # skip the config's setup steps (env/ports only)
githog setup --create my-feature --dry-run    # print the plan, change nothing
```

Re-running on an already-isolated worktree is idempotent — it reuses the existing ports.

### `githog implement-issues`

For each GitHub issue: create a worktree, provision it, open a herdr surface pointed at it, launch the agent, wait until it's ready, then type the prompt. Run from inside the target repo, in a herdr session.

```bash
githog implement-issues 21 22 23
githog 21                                  # bare form (no subcommand) implies implement-issues
githog https://github.com/<you>/myapp/issues/21
```

An issue can be a number or a full GitHub issue URL. A URL is a convenience over the number — it must point at the repo you're running in (the worktree is branched from the local clone here; githog does no cross-repo lookup or cloning), and a URL for a different repo is rejected with a clear message.

Worktrees are provisioned **sequentially** (the port scanner reads sibling `.env` files, so parallel setup would hand out colliding ports); the wait-for-ready gate then sequences each agent launch.

### `githog kill`

The inverse — tear a worktree down completely.

```bash
githog kill 33
githog kill my-feature other-branch
```

Takes branch names (a number or issue URL maps to its branch under the default scheme). It closes the herdr worktree workspace, removes the git worktree, and deletes the branch — each step best-effort and idempotent, so re-running or killing a partially-gone worktree is safe.

## Develop

```bash
bun run typecheck   # tsc --noEmit
bun test            # pure-helper unit tests
```

Built on Effect 4 (`effect@beta`) and `@effect/platform-bun`. Subprocess work uses `effect/unstable/process`; the CLI runs on `BunRuntime`/`BunServices`.
