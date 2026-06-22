import { Console, Effect } from "effect";
import { applyFocus, applyPoll, applyStatus, type Status, type Store } from "./store.ts";

// The seam between `listen` and its presentation. `listen` calls these instead of
// printing directly; the console reporter logs lines (plain CLI), the tui reporter
// drives the dashboard store. Methods return Effect so listen can `yield*` them.

export interface HeaderInfo {
  readonly repoName: string;
  readonly readyLabel: string;
  readonly intervalSeconds: number;
  readonly maxConcurrent: number;
}

export interface StatusUpdate {
  readonly number: number;
  readonly title: string;
  readonly status: Status;
  readonly step?: string | undefined;
  readonly pane?: string | undefined;
}

export interface PollUpdate {
  readonly queued: ReadonlyArray<{ number: number; title: string }>;
  readonly active: number;
  readonly newNumbers: ReadonlyArray<number>;
  readonly finishedNumbers: ReadonlyArray<number>;
}

export interface Reporter {
  readonly header: (info: HeaderInfo) => Effect.Effect<void>;
  readonly poll: (update: PollUpdate) => Effect.Effect<void>;
  readonly status: (update: StatusUpdate) => Effect.Effect<void>;
  readonly focus: (number: number | undefined) => Effect.Effect<void>;
}

// Plain CLI: a readable line log, equivalent to the pre-dashboard output.
export const consoleReporter: Reporter = {
  header: (info) =>
    Console.log(
      `\n▸ githog listen — repo ${info.repoName}, trigger '${info.readyLabel}', every ${info.intervalSeconds}s, max ${info.maxConcurrent} concurrent agents`,
    ),
  poll: (update) =>
    update.newNumbers.length === 0 && update.finishedNumbers.length === 0
      ? Effect.void
      : Console.log(
          `  poll: ${update.queued.length} ready, ${update.active} active` +
            (update.newNumbers.length > 0 ? ` · new ${update.newNumbers.map((n) => `#${n}`).join(",")}` : "") +
            (update.finishedNumbers.length > 0
              ? ` · finished ${update.finishedNumbers.map((n) => `#${n}`).join(",")}`
              : ""),
        ),
  status: (update) =>
    Console.log(`  #${update.number} ${update.status}${update.step ? ` (${update.step})` : ""}`),
  focus: () => Effect.void,
};

// TUI: drive the dashboard store. Each call is a synchronous store update.
export const tuiReporter = (store: Store): Reporter => ({
  header: (info) =>
    Effect.sync(() =>
      store.update((s) => ({
        ...s,
        repoName: info.repoName,
        readyLabel: info.readyLabel,
        intervalSeconds: info.intervalSeconds,
        maxConcurrent: info.maxConcurrent,
      })),
    ),
  poll: (update) => Effect.sync(() => store.update((s) => applyPoll(s, update))),
  status: (update) => Effect.sync(() => store.update((s) => applyStatus(s, update))),
  focus: (number) => Effect.sync(() => store.update((s) => applyFocus(s, number))),
});
