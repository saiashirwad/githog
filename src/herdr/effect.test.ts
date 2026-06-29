import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  matcher,
  openWorkspaceIdForBranch,
  WorkspaceCreatedSchema,
  WorkspaceListSchema,
  workspaceIdForLabel,
  WorktreeListSchema,
} from "./types.ts";

test("matcher substring vs regex", () => {
  const sub = matcher("hello", false);
  expect(sub("say hello world")).toBe(true);
  expect(sub("nope")).toBe(false);

  const re = matcher("^ready>", true);
  expect(re("ready> ok")).toBe(true);
  expect(re("not ready")).toBe(false);
});

test("openWorkspaceIdForBranch returns workspace id when branch matches", () => {
  const worktrees = [
    { branch: "main", open_workspace_id: "ws-main" },
    { branch: "42", open_workspace_id: "ws-42" },
  ];
  expect(openWorkspaceIdForBranch(worktrees, "42")).toBe("ws-42");
});

test("openWorkspaceIdForBranch returns undefined when branch absent", () => {
  const worktrees = [{ branch: "main", open_workspace_id: "ws-main" }];
  expect(openWorkspaceIdForBranch(worktrees, "missing")).toBeUndefined();
});

test("openWorkspaceIdForBranch returns undefined when open_workspace_id is null", () => {
  const worktrees = [{ branch: "42", open_workspace_id: null }];
  expect(openWorkspaceIdForBranch(worktrees, "42")).toBeUndefined();
});

test("WorktreeListSchema decodes herdr worktree list JSON", async () => {
  const json = JSON.stringify({
    result: {
      worktrees: [
        { branch: "42", open_workspace_id: "ws-42" },
        { branch: "main", open_workspace_id: null },
      ],
    },
  });
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreeListSchema))(json),
  );
  expect(openWorkspaceIdForBranch(decoded.result.worktrees, "42")).toBe("ws-42");
  expect(openWorkspaceIdForBranch(decoded.result.worktrees, "main")).toBeUndefined();
});

test("workspaceIdForLabel returns workspace id when label matches", () => {
  const workspaces = [
    { workspace_id: "w1", label: "issue-30" },
    { workspace_id: "w2", label: "[dispatched]" },
  ];
  expect(workspaceIdForLabel(workspaces, "[dispatched]")).toBe("w2");
  expect(workspaceIdForLabel(workspaces, "missing")).toBeUndefined();
});

test("workspaceIdForLabel ignores a null label", () => {
  const workspaces = [{ workspace_id: "w1", label: null }];
  expect(workspaceIdForLabel(workspaces, "[dispatched]")).toBeUndefined();
});

test("WorkspaceListSchema decodes herdr workspace list JSON (label + workspace_id only)", async () => {
  const json = JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: [
        { label: "issue-30", number: 1, workspace_id: "w1", agent_status: "idle" },
        { label: "[dispatched]", number: 2, workspace_id: "w2" },
      ],
    },
  });
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceListSchema))(json),
  );
  expect(workspaceIdForLabel(decoded.result.workspaces, "[dispatched]")).toBe("w2");
});

test("WorkspaceCreatedSchema extracts the new workspace id", async () => {
  const json = JSON.stringify({
    id: "cli:workspace:create",
    result: {
      type: "workspace_created",
      root_pane: { pane_id: "w3:p1", workspace_id: "w3" },
      workspace: { label: "[dispatched]", number: 3, workspace_id: "w3" },
    },
  });
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceCreatedSchema))(json),
  );
  expect(decoded.result.workspace.workspace_id).toBe("w3");
});
