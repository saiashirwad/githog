import type { Console } from "effect/Console";
import { applyLog, type Store } from "./store.ts";

// A Console that routes everything into the dashboard's focused-issue log instead
// of stdout — provided over the listen program in TUI mode so existing Console.log
// calls (and captured subprocess output) can't scribble over the rendered UI.
export const makeTuiConsole = (store: Store): Console => {
  const noop = () => {};
  const route = (...args: ReadonlyArray<unknown>) => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    // Effect's Console.log adds no trailing newline handling we care about; split
    // multi-line output so each shows as its own row.
    for (const part of line.split("\n")) store.update((s) => applyLog(s, part));
  };
  return {
    assert: noop,
    clear: noop,
    count: noop,
    countReset: noop,
    debug: route,
    dir: noop,
    dirxml: noop,
    error: route,
    group: route,
    groupCollapsed: route,
    groupEnd: noop,
    info: route,
    log: route,
    table: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    trace: route,
    warn: route,
  };
};
