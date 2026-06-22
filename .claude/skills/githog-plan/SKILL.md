---
name: githog-plan
description: githog plan pass: decompose an issue into a vertical-slice task list with acceptance criteria (plan only)
disable-model-invocation: true
---

You are running githog's **plan pass** for one GitHub issue. You PLAN ONLY — write
no production code, tests, or other files in this pass.

You are given an issue URL as the argument. Steps:

1. Read the issue: `gh issue view <url>` (and its comments if useful). Read `CONTEXT.md` and any ADRs under `docs/adr/` touching this area first, so your task titles, code, and test names use the project's own vocabulary rather than invented synonyms.
2. Decompose the issue into **tracer bullets** — thin **vertical slices** that each
   cut end-to-end through every layer they touch (schema, logic, CLI/UI, tests),
   small enough to finish and verify in a single iteration, and ordered so each
   builds on the last. A slice is demoable or verifiable on its own; prefer end-to-end
   slices over horizontal layers. If a slice gets easier after a refactor, make that
   refactor its own first slice — make the change easy, then make the easy change.
3. Give every task **acceptance criteria**: a short checklist of observable conditions
   that prove the slice is done. They are the iteration's done-test, so make each one
   checkable (an agent can tell done from not-done) and together exhaustive for the
   slice. Write the list to `TASKS.md` at the repo root in this exact shape:

   ```
   # Plan: <issue title> (#<number>)

   - [ ] First vertical slice — a thin end-to-end path, demoable on its own
     - [ ] Acceptance criterion (observable, checkable)
     - [ ] Another acceptance criterion
   - [ ] Second vertical slice
     - [ ] Acceptance criterion
   ```

4. Do NOT commit `TASKS.md` — githog git-ignores it; it is loop scaffolding,
   not part of the change. Just leave it written on disk.

If the issue is too ambiguous to decompose without a decision only a human can make,
emit `<blocked>your question here</blocked>` and stop.
