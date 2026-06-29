# homestead

Two worktrees of the same repo both want port 3000 and the same database. homestead gives each one its own ports, its own `.env`, its own setup — opened in a [herdr](https://herdr.dev) pane.

```bash
homestead worktree my-feature
```

A branch, provisioned and open, in one command.

## An agent per issue

```bash
homestead issue 21 22 23
```

Three worktrees, three panes, a coding agent booted in each and handed its issue.

Stack a later wave on an integration branch so it sees earlier work without merging to the default branch first:

```bash
homestead issue 24 25 --from integration
```

`--from` overrides the base per run; set `issues.base` in the config to make it the persistent default.

Tear one down when you're done:

```bash
homestead close 21        # keep the branch, move the issue to review
homestead complete 21     # merged — remove the worktree and branch
homestead kill 21         # discard it
```

## Land a finished branch

```bash
homestead land 21              # merge → regenerate → verify → keep only if green
homestead land 21 --complete  # …and on green, run `homestead complete` for you
```

Integrating a finished branch by hand is the same chore every time: stash WIP, merge, rebuild generated files (a text merge of those is wrong), run checks, commit only if green. `land` owns it — and rolls the whole merge back on red, returning your stashed WIP either way. Run it from the primary checkout on the default branch; pass several branches to land them in order. Configure the regenerate and verify commands under `land`.

## See everything at once

```bash
homestead ls
```

A read-only dashboard — one row per worktree, joining git, each `.env`, tracking state, and herdr:

```
SLUG         BRANCH       PORTS              DB              AGENT     PANE   ORIGIN
auth-rework  auth-rework  WEB=3001 API=4001  hs_authrework   running   ws-7   you
issue-142    142          WEB=3002 API=4002  hs_142          done      —      [auto]
```

Every column degrades to `—` on its own if a source is missing; it never mutates anything.

## Someone else's PR

Pull a PR into a real worktree instead of reading a web diff:

```bash
homestead review 87       # read-only, Claude reviews it
homestead pr 87           # Claude continues it and pushes (same-repo only)
```

## Setup

```bash
bun add -g homestead
homestead init
```

`init` leaves you a fully typed `homestead.config.ts` — ports, env, setup steps, agent:

```ts
import type { HomesteadConfig } from "./generated/homestead.config.types";

export default {
  ports: [{ key: "PORT", base: 3000 }],
  env: {
    source: ".env",
    derive: ({ slug }) => ({ DATABASE_URL: `.../${slug}` }),
  },
  setup: [{ label: "install", run: ["bun", "install"] }],
  agent: { command: ["claude"], surface: "worktree" },
} satisfies HomesteadConfig;
```

It goes further — per-issue agent prompts, shared services, lifecycle hooks. The [example config](./homestead.config.example.ts) covers the rest.

## Driving homestead from an agent

Any coding agent can drive worktree orchestration through a small, stable contract — the status sentinel, `agent wait` exit codes, and provenance markers. See [docs/ORCHESTRATION.md](./docs/ORCHESTRATION.md).

## Requirements

git, a herdr session, [Bun](https://bun.sh), and an authenticated `gh` for issue and PR flows.
