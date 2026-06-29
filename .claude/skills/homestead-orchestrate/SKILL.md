---
name: homestead-orchestrate
description: Use when the user wants to drive a whole goal or a set of interdependent issues across parallel worktrees at once — triggers like "build all these issues", "work this goal across worktrees", "fan out", "spawn agents for this backlog". Composes homestead plan / issue / agent spawn+wait / land into the build→integrate→advance loop, bounded by file collisions and gated by verify-after-merge.
---

# homestead-orchestrate

## Overview

Take a coding agent from "here is a goal / a set of issues" to "all of it built, integrated green, and finalized" — by **calling the building-block commands in the right order**, not by hand-rolling the mechanics. homestead already owns every deterministic piece: `homestead plan` computes the wave schedule, `homestead issue` / `agent spawn` dispatch the work, `homestead agent wait` reads the outcome, `homestead land` does the integrate-and-verify dance. Your job is to compose them into one loop and enforce the two laws those commands exist to enforce.

**The one spine: you call commands, you do not re-implement them.** The schedule comes from `homestead plan`, not your gut. The integrate dance comes from `homestead land`, not a hand `git merge`. The done/blocked/failed verdict comes from `homestead agent wait`, not from eyeballing a pane. Every time the playbook re-derives mechanics by hand, it drifts from the tested commands and silently re-introduces the exact bugs they fixed.

You are allowed **exactly two pieces of judgment** the commands can't encode — see *Thin-judgment boundary* at the end. Everything else defers.

**Precondition — autonomous mode.** This unattended fan-out only works because dispatched agents run *autonomous*: the kickoff drops the plan-gate ("show me your plan"), so an agent builds to completion instead of parking at a plan and waiting for a human who isn't watching, and the **harness** (not the model) writes the done-signal from the project's `check` command when the agent exits. Confirm `agent.autonomous` is configured before you fan out; without it, every dispatched agent stalls at its plan and the loop never advances.

## The loop

### 1. Map — `homestead plan <issues…>`

Run `homestead plan` over the whole issue set first. It reads each issue's `touches:` / `depends-on:` block and emits collision-aware build **waves** plus a single serial **integrate** order:

```
Wave 1 (build in parallel): #12 …, #14 …
Wave 2 (build in parallel): #13 …  [waits on #12]
Integrate (serial, gate green each): #12 → #14 → #13
```

Use `--json` if you want the machine shape (`{ waves, integrate, warnings }`). **Read its output; do not re-compute it by hand** — the schedule is derived from declared file sets, not from how related the issues sound.

**If an issue lacks a `touches:` block**, `plan` warns and schedules it alone for safety. That's a signal, not a result: defer to the **homestead-decompose** skill (or, if it isn't installed, decompose by hand — split the goal into units that each declare a `touches:`/`depends-on:` block) **before** planning, so the scheduler has real file sets to work from. *When to decompose is one of your two judgment calls.*

### 2. Batch into waves

Within a wave, agents build **in parallel**; integration is **serialized**, one branch at a time. Trust `plan`'s grouping — do not regroup by hand.

> **Law 1 — parallelism is bounded by shared files, not logic.** Two issues can be logically independent and still land in *different* waves because their `touches:` sets overlap; two issues that *sound* related can run together if their files are disjoint. `homestead plan` already enforces this from the `touches:` metadata. Your job is to **not override it by feel** — never promote two issues into the same wave because they "seem unrelated," and never split a wave the scheduler kept together.

### 3. Dispatch the wave

For each member of the current wave, in parallel:

- **Has an issue** → `homestead issue <n>`.
- **Issue-less unit** → `homestead agent spawn <slug> "<prompt>"`.
- **Wave depends on an unmerged predecessor** → `homestead issue <n> --from <integration-branch>` so it forks off that branch. When the predecessor wave is already **landed-green into local `main`**, you don't need `--from` and you don't need to push — later waves compose off local `main` automatically.

Each dispatch provisions a worktree (its own ports / `.env` / setup) and boots an autonomous agent on the kickoff prompt. After launch, homestead is hands-off until the agent signals.

### 4. Await each agent — `homestead agent wait <target>`

Block on every dispatched agent and **branch on the exit code** (the 0/1/2/3 contract):

| Exit | Outcome | Do |
|---|---|---|
| `0` | **done** | Eligible to integrate. |
| `1` | **failed** | Inspect / retry. Do not integrate. |
| `2` | **blocked** | Surface to the human for a decision. **Do not integrate.** |
| `3` | **no-signal** | Investigate — the agent stopped without a trustworthy signal. |

> **`3` / no-signal is NEVER treated as success.** It means the deadline elapsed *or* herdr reports the pane went idle/done but no `.homestead/agent-status.json` was written. The sentinel a model writes itself is only ~50% reliable, and the old "the REPL drew its `❯` prompt, so it's done" backstop was outright broken (Claude's TUI draws `❯` while actively working). `agent wait` now reads herdr's structured `agent_status` as the backstop — so exit `3` is a real "I don't know," never a quiet pass. Treat it as investigate, not done.

Defer the per-agent wait mechanics (timeouts, `--pane` backstop, poll interval) to the **homestead-await** skill, or call `homestead agent wait` directly if that skill isn't installed.

### 5. Integrate, one at a time — `homestead land <branch>`

For each `done` branch, **in the serial integrate order from step 1**, run `homestead land <branch>`. It merges into the default branch, regenerates generated files (`bun run gen:config-types`), runs `bun run check`, and **keeps the merge only if it's green** — otherwise it rolls back. Land **one branch at a time** and gate on the result before the next.

> **Law 2 — a clean textual merge is not a correct merge.** git once auto-merged an entire wave with zero conflicts and still produced a broken tree: one issue added a required field, another issue's test fixtures didn't have it — a *semantic* conflict git cannot see. So the rule is **run the verify gate after every merge and gate on green.** `homestead land` is that gate. **On red: stop the wave.** Never land the next branch on top of a failing tree — investigate, then retry, or escalate to the human. *What to do on a red gate is your second judgment call.*

Defer the integrate-and-verify mechanics to the **homestead-land** skill, or call `homestead land` directly if that skill isn't installed.

### 6. Advance

When **every** branch in the wave has landed green, move to the next wave. Its `--from` base is now satisfied via local `main`, so the next wave's dispatches compose cleanly. Repeat steps 3–5 per wave. If a wave went red and you couldn't get it green, **stop here** and surface it — do not start the next wave on a broken base.

(Optional: `homestead ls --watch` gives a live dashboard of every worktree's state while waves are in flight.)

### 7. Finalize

When all waves are green, push and close per the user's intent — and **defer the irreversible parts**:

- Landing-and-completing your own issue branches → `homestead land --complete`, or the **homestead-teardown** skill. `complete` deletes the branch (local **and** remote) and closes the issue — it is irreversible; never auto-chain it without the user's say-so.
- Human-facing PRs (review / continue someone's PR) → route through the **homestead-pr-triage** skill.

## Guardrails

- **Two laws, restated, because they're the whole point:** (1) **parallelism is bounded by shared files, not logic** — let `homestead plan` / `touches:` set the waves; (2) **a clean textual merge ≠ a correct merge** — run `homestead land`'s verify gate after every merge and gate on green.
- **`3` / no-signal is not done.** Never integrate a branch whose agent exited `3` (or `2`). Only `0` is eligible.
- **Stop the wave on red.** A failed land halts the wave. Don't pile the next branch on a failing tree.

### Thin-judgment boundary — the one design rule

The skill calls commands; it does **not** re-implement them. Specifically it does **not** hand-roll:

- **wave math** — that's `homestead plan`;
- **the integrate dance** (merge → regenerate → verify → keep/rollback) — that's `homestead land`;
- **sentinel polling / the idle backstop** — that's `homestead agent wait`.

You own exactly **two** judgments the commands can't encode:

1. **When to decompose** — if issues lack `touches:` blocks, split them (via **homestead-decompose**) before planning.
2. **What to do on a red gate** — stop the wave, then retry vs. escalate to the human.

Everything else defers to a building-block skill (**homestead-await**, **homestead-land**, **homestead-decompose**, **homestead-pr-triage**, **homestead-teardown**) — or, when that skill isn't installed, to the underlying command named alongside it. If you find yourself computing waves, merging by hand, or judging "done" from a pane, stop: you've crossed the boundary and you're re-introducing the bugs the commands fixed.
