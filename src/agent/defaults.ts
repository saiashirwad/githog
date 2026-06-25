import { resolveCallable } from "../callable.ts";
import type { HomesteadContext } from "../context.ts";
import type { AgentConfig, AgentPromptContext } from "../types.ts";

export const DEFAULT_AGENT_COMMAND = ["claude"] as const;
export const DEFAULT_AGENT_READY_MARKER = "❯";
export const DEFAULT_CLAUDE_TRUST_PROMPT = {
  marker: "trust this folder",
  confirm: ["Enter"],
} as const;

export const defaultAgentPrompt = (ctx: AgentPromptContext): string => {
  const item = ctx.item;
  return (
    `This is the issue you need to implement:\n\n` +
    `#${item.number}: "${item.title}"\n${item.url}\n\n` +
    `Read the issue carefully and explore this worktree until you understand exactly what needs to be done. ` +
    `Then show me your plan before you start implementing.`
  );
};

export type CommandContext = HomesteadContext & { readonly args: ReadonlyArray<string> };

export const resolveCommand = (
  cfg:
    | ReadonlyArray<string>
    | ((ctx: CommandContext) => ReadonlyArray<string>)
    | undefined,
  ctx: CommandContext,
): ReadonlyArray<string> => resolveCallable(cfg, ctx, DEFAULT_AGENT_COMMAND);

export const resolveAgentDefaults = (agent: AgentConfig): AgentConfig & {
  readonly prompt: (ctx: AgentPromptContext) => string;
} => {
  const command = agent.command;
  const binary =
    typeof command === "function" ? "claude" : (command ?? DEFAULT_AGENT_COMMAND)[0] ?? "claude";
  const trustPrompt =
    agent.trustPrompt !== undefined
      ? agent.trustPrompt
      : binary === "claude"
        ? DEFAULT_CLAUDE_TRUST_PROMPT
        : undefined;

  return {
    ...agent,
    command: typeof command === "function" ? command : (command ?? DEFAULT_AGENT_COMMAND),
    trustPrompt,
    prompt: agent.prompt ?? defaultAgentPrompt,
  };
};
