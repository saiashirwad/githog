# githog

**Config-driven git-worktree + agent provisioning.** Built on [Effect](https://effect.website) (v4) and [Bun](https://bun.sh).

githog gives each git worktree an isolated dev environment — its own ports, database, and `.env` — and can run a batch of GitHub issues as parallel coding agents, one worktree apiece. A `githog.config.ts` at your repo root describes how to provision a worktree.

```bash
githog setup --create my-feature        # isolate a new worktree (ports, .env, services, setup)
githog implement-issues 21 22 23         # one worktree + agent per issue, in parallel
githog listen                            # auto-implement issues labelled `agent:ready`
githog kill my-feature                   # remove the worktree, branch, and agent surface
```

## Why

Multiple worktrees of one repo collide: they share a database, fight over dev ports (`3000`, `5173`, …), and each needs its `.env` set up by hand. githog gives each worktree its own database named for the branch, the next free ports, and a rewritten `.env`, so any number of worktrees run side by side.

`implement-issues` reuses this provisioning, then attaches an agent to each worktree.

## Install

```bash
git clone https://github.com/<you>/githog
cd githog
bun install        # also clones Effect's source into .repos/effect
bun link           # puts a `githog` binary on your PATH
```

The bin is a live symlink to the source, so `git pull` updates it without a rebuild.

**Runtime prerequisites** (per command):

- `git` — always
- `gh` (authenticated) — for `implement-issues`, `listen`, and issue tracking
- a herdr terminal session — for `implement-issues`, `listen`, and the herdr side of `kill`

## Configure

Each project using githog has a `githog.config.ts` at its repo root. See [`githog.config.example.ts`](./githog.config.example.ts) for a worked example.

```ts
import { defineConfig } from "githog";

export default defineConfig({
  // ports made unique per worktree
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  env: {
    source: ".env",
    fallback: ".env.example",
    // per-worktree derived keys
    derive: ({ slug, env }) => ({
      DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT_DB_URL, `myapp_${slug}`),
    }),
  },

  // probed before setup; started via `start` if down
  services: [
    { name: "postgres", host: "localhost", port: 5432, start: ["docker", "compose", "up", "-d", "db"] },
  ],

  // provisioning commands, in order
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
    { label: "seed", run: ["bun", "run", "db:seed"], injectEnv: ["DATABASE_URL"], fatal: false },
  ],

  // the Ralph loop (ADR-0001)
  agent: {
    command: ["claude"],
    loop: { maxIterations: 25 },
  },
});
```

| Field | What it controls |
| --- | --- |
| `ports` | env keys made unique per worktree. githog scans every sibling worktree's `.env` and takes the lowest free value ≥ `base`. |
| `env.source` / `env.fallback` | which `.env` body to copy from the primary checkout. Defaults to `.env`, falling back to `.env.example`. |
| `env.derive` | returns per-worktree key overrides, e.g. a DB name keyed off the branch `slug`. |
| `services` | TCP dependencies probed before setup. If one is unreachable, githog runs its `start` command and polls until it's up. |
| `setup` | ordered commands. Tokens `{{slug}}`, `{{branch}}`, `{{targetDir}}`, and `{{env:KEY}}` are substituted. `injectEnv` puts computed-env values in the child's environment, overriding any baked-in `--env-file`. `fatal: false` warns and continues. |
| `agent` | `command` (default `["claude"]`), `surface` (`"worktree"`, `"workspace"`, or `"tab"`), and the `loop` block. |
| `agent.loop` | Ralph loop knobs. `maxIterations` (default 25), `completionSentinel` / `blockedTag` (default `<promise>COMPLETE</promise>` / `blocked`), `planSkill` / `implementSkill` (default `githog-plan` / `githog-implement`), `taskFile` (default `TASKS.md`), `seedSkills` (default true), and `planPrompt` / `iterationPrompt` overrides. |
| `worktreeDir` | where new worktrees land (default `~/worktrees/<repo>/<slug>`). |
| `issues.branch` | branch name per issue (default the issue number). |
| `issues.label` / `issues.assign` / `issues.comment` | opt-in issue tracking — see below. |
| `issues.reviewLabel` / `issues.blockedLabel` | terminal labels the loop swaps `agent:wip` into (default `agent:review` / `agent:blocked`). Both free a `listen` slot. |
| `afterSetup` | an Effect escape hatch for arbitrary provisioning, with the full Bun platform (`FileSystem`, `Path`, subprocess) in scope. |

### Issue tracking (opt-in)

githog can mark a GitHub issue when an agent starts and reverse it on `kill`, so you can see which issues an agent is on. All three are opt-in: omit them and githog never touches your tracker.

```ts
issues: {
  label: "agent:wip",                          // add on start (auto-created), remove on kill
  assign: true,                                // assign the gh user (@me) on start, unassign on kill
  comment: true,                               // 🤖 start comment + 🛑 stop comment
  // comment: (ctx) => `started on ${ctx.branch} @ ${ctx.host}`,  // ...or custom text
}
```

githog records what it applied (per repo+branch, under `~/.githog/state/`), so `kill` reverses what githog set and nothing else, even with custom branch names. Every gh call is best-effort: a failure warns and continues without aborting provisioning or teardown. Done is signaled by your PR or merge; githog only tracks start (`implement-issues`) and stop (`kill`).

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

For each GitHub issue: create a worktree, provision it, open a herdr surface pointed at it, and start the **Ralph loop** inside that pane (see below). Run from inside the target repo, in a herdr session.

```bash
githog implement-issues 21 22 23
githog 21                                  # bare form (no subcommand) implies implement-issues
githog https://github.com/<you>/myapp/issues/21
```

An issue is a number or a full GitHub issue URL. The URL must point at the repo you're running in — the worktree is branched from the local clone, and githog does no cross-repo lookup or cloning. A URL for another repo is rejected.

Worktrees are provisioned **sequentially**: the port scanner reads sibling `.env` files, so parallel setup would hand out colliding ports. Each loop then runs independently in its own herdr pane.

### The Ralph loop

Rather than taking one shot at an issue, githog drives the agent to done (see [ADR-0001](./docs/adr/0001-githog-driven-ralph-loop.md)). After a worktree is provisioned, githog runs `githog loop <issue>` inside the herdr pane:

1. **Plan pass** — a one-shot `claude -p` run (`/githog-plan`) decomposes the issue into an atomic task list, committed to `TASKS.md` as the loop's first commit and its cross-iteration memory.
2. **Iterations** — each iteration is a fresh `claude -p` run (`/githog-implement`) with a clean context: pick the next incomplete task from `TASKS.md`, implement it, run its checks, commit, mark it done.
3. **Stop** — githog parses each run's output for sentinels. `<promise>COMPLETE</promise>` ends the loop; the iteration cap or a `<blocked>reason</blocked>` ends it as blocked.
   - **Complete** → `gh pr create` from the branch, link the issue, swap `agent:wip → agent:review`. The worktree is left up for inspection.
   - **Blocked** → push the partial branch, swap `agent:wip → agent:blocked`, post the reason as a comment. No PR.

The prompt logic ships as editable Claude skills (`githog-plan`, `githog-implement`), seeded into each worktree at provision time so you can read, tune, or run them by hand; a built-in default applies if a skill is absent. Override the cap, sentinels, skill names, or custom prompts via `agent.loop`.

### `githog listen`

Watch the repo and auto-implement issues as they're queued. Run it in a long-lived herdr pane.

```bash
githog listen
```

Label an issue `agent:ready` and githog claims it (swapping the label to `agent:wip` so it's never grabbed twice), then runs the same flow as `implement-issues`: provision a worktree and start the Ralph loop. The label is the queue:

```
agent:ready ──(githog claims)──► agent:wip ──(loop completes)──► agent:review (PR open)
                                          └──(cap / <blocked>)──► agent:blocked
```

It polls every `intervalSeconds` (default 30), runs at most `maxConcurrent` loops at once (default 3, counted as open `agent:wip` issues, so `agent:review` and `agent:blocked` both free a slot), and skips any issue whose branch already exists. A failure on one issue or one poll logs and continues without killing the daemon.

```ts
listen: { label: "agent:ready", intervalSeconds: 30, maxConcurrent: 3 }
```

On an interactive terminal, `listen` renders a dashboard ([OpenTUI](https://opentui.com)) with three columns — queued, in progress, done — and a detail pane showing the current issue's provisioning step and setup output. New issues flash `NEW`; finished ones move to done. Press `q` to quit; agents keep running in their herdr panes. Piped, non-TTY, or `--plain` falls back to line logs.

```
┌ githog listen ──── orderservice · trigger agent:ready · every 30s · 2/3 active ┐
│ QUEUED (1)          IN PROGRESS (2)            DONE (2)                         │
│  · #42 tax bug NEW   ⟳ #34 import gate worktree  ✓ #29 payee refactor          │
│                      ▸ #37 webhook retries       ✓ #31 seed cleanup            │
├ detail · #34 ───────────────────────────────────────────────────────────────  │
│  ⟳ provisioning · worktree                                                     │
│  > pnpm --filter @app/server db:migrate                                        │
│  [✓] migrations applied successfully                                           │
└ q quit · agents run in their own herdr worktree panes ───────────────────────  ┘
```

Detection is by polling, since a local CLI can't receive GitHub webhooks; it needs no infra and works behind NAT. Claiming is a label swap, so running `listen` on two machines against one repo leaves a small race window — fine for a single dev box.

### `githog kill`

Tear a worktree down completely.

```bash
githog kill 33
githog kill my-feature other-branch
```

Takes branch names; a number or issue URL maps to its branch under the default scheme. It closes the herdr worktree workspace, removes the git worktree, and deletes the branch. Each step is best-effort and idempotent, so re-running or killing a partially-gone worktree is safe.

## Develop

```bash
bun run typecheck   # tsc --noEmit
bun test            # pure-helper unit tests
```

Built on Effect 4 (`effect@beta`) and `@effect/platform-bun`. Subprocess work uses `effect/unstable/process`; the CLI runs on `BunRuntime`/`BunServices`.
