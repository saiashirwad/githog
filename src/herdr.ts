import { Console, Effect, Schema } from "effect";
import { capture } from "./process.ts";
import type { AgentConfig, WorkItem } from "./types.ts";

// claude's idle-footer hint — present once the TUI is ready for input. The two
// wordings cover the permission-mode footer and the default shortcuts footer.
const DEFAULT_READY_MARKER = "to cycle|for shortcuts";
const DEFAULT_READY_TIMEOUT_MS = 90000;
const DEFAULT_COMMAND = ["claude"] as const;

// `herdr worktree open` / `workspace create` / `tab create` all nest the new
// pane at result.root_pane.pane_id.
const SurfaceCreated = Schema.Struct({
  result: Schema.Struct({ root_pane: Schema.Struct({ pane_id: Schema.String }) }),
});
const decodeSurfaceCreated = Schema.decodeUnknownEffect(Schema.fromJsonString(SurfaceCreated));

// Thin wrapper over the herdr CLI; returns trimmed stdout (JSON for create,
// empty for run/send-*). Talks to the running herdr over its unix socket.
const herdr = (...args: ReadonlyArray<string>) => capture("herdr", args);

const createSurface = Effect.fn("githog/create-surface")(function* (
  surface: "worktree" | "workspace" | "tab",
  dir: string,
  label: string,
) {
  // The parent repo workspace to nest under — the herdr workspace githog is
  // running in (the repo's main). HERDR_WORKSPACE_ID is set inside every pane.
  const parent = process.env.HERDR_WORKSPACE_ID;
  const parentArg = parent === undefined ? ["--cwd", process.cwd()] : ["--workspace", parent];

  // "worktree" (default): open the git worktree githog just created as a CHILD
  // of the repo's workspace, so it nests under it in herdr (rather than a flat
  // detached workspace, which is what `workspace create --cwd` produces).
  const args =
    surface === "tab"
      ? ["tab", "create", ...parentArg, "--cwd", dir, "--label", label, "--no-focus", "--json"]
      : surface === "workspace"
        ? ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus"]
        : ["worktree", "open", ...parentArg, "--path", dir, "--label", label, "--no-focus", "--json"];

  const created = yield* decodeSurfaceCreated(yield* herdr(...args)).pipe(Effect.orDie);
  return created.result.root_pane.pane_id;
});

// For one work item: open a herdr surface at the worktree, launch the agent
// command, wait for it to be READY, then type the initial prompt + a real Enter.
// (A slash command needs the literal text typed and then a separate Enter, which
// is why this is send-text + send-keys, not `pane run`.)
export const launchAgent = Effect.fn("githog/launch-agent")(function* (
  item: WorkItem,
  dir: string,
  agent: AgentConfig,
) {
  const command = agent.command ?? DEFAULT_COMMAND;
  const [agentCmd, ...agentArgs] = command;
  const readyMarker = agent.readyMarker ?? DEFAULT_READY_MARKER;
  const readyTimeoutMs = agent.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const surface = agent.surface ?? "worktree";

  yield* Console.log(`\n▸ Launching agent for issue #${item.number} in ${dir}`);
  const pane = yield* createSurface(surface, dir, `issue-${item.number}`);

  yield* herdr("pane", "run", pane, agentCmd ?? "claude", ...agentArgs);
  yield* herdr(
    "wait",
    "output",
    pane,
    "--match",
    readyMarker,
    "--regex",
    "--timeout",
    String(readyTimeoutMs),
  );

  const prompt = agent.prompt(item);
  yield* herdr("pane", "send-text", pane, prompt);
  yield* Effect.sleep("400 millis");
  yield* herdr("pane", "send-keys", pane, "Enter");

  yield* Console.log(`  ✓ #${item.number}: ${prompt}  (herdr pane ${pane})`);
});
