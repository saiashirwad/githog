// homestead — config-driven git-worktree + agent provisioning, built on Effect.
//
// Public surface for authoring a homestead.config.ts and for embedding the
// provisioner in your own Effect programs. The CLI lives in src/cli.ts
// (bin: `homestead`).

export { defineConfig, loadConfig } from "./src/config.ts";
export { setupWorktree } from "./src/worktree.ts";
export { resolveIssue } from "./src/issues.ts";
export { launchAgent } from "./src/herdr.ts";
export { listen } from "./src/listen.ts";
export { ConfigInvalid, ConfigNotFound, ServiceUnavailable } from "./src/errors.ts";
export type {
  AgentConfig,
  EnvConfig,
  HomesteadConfig,
  HomesteadServices,
  IssuesConfig,
  ListenConfig,
  Plan,
  PortSpec,
  ServiceSpec,
  SetupStep,
  TrackingContext,
  WorkItem,
  WorktreeContext,
  WorktreeOptions,
} from "./src/types.ts";
