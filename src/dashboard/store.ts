// Framework-agnostic external store: the Effect `listen` loop writes it, the
// OpenTUI React app reads it via useSyncExternalStore. Keeping it a plain store
// (not an Effect SubscriptionRef) avoids coupling the render loop to the runtime.

export type Status = "queued" | "claiming" | "provisioning" | "implementing" | "finished" | "failed";

export interface IssueRow {
  readonly number: number;
  readonly title: string;
  readonly status: Status;
  readonly step?: string | undefined; // current setup step / sub-state
  readonly pane?: string | undefined; // herdr pane once launched
  readonly isNew?: boolean | undefined; // pulled in on the latest poll
  readonly finishedAt?: number | undefined;
}

export interface DashboardState {
  readonly repoName: string;
  readonly readyLabel: string;
  readonly intervalSeconds: number;
  readonly maxConcurrent: number;
  readonly activeCount: number;
  readonly rows: Readonly<Record<number, IssueRow>>;
  readonly focused?: number | undefined; // issue currently being provisioned (its log shows in detail)
  readonly log: ReadonlyArray<string>; // tail of the focused issue's captured output
  readonly polls: number; // how many times we've polled (for a heartbeat)
  readonly error?: string | undefined;
}

export interface Store {
  getSnapshot(): DashboardState;
  subscribe(onChange: () => void): () => void;
  update(fn: (state: DashboardState) => DashboardState): void;
}

export const initialState = (init: {
  repoName: string;
  readyLabel: string;
  intervalSeconds: number;
  maxConcurrent: number;
}): DashboardState => ({
  ...init,
  activeCount: 0,
  rows: {},
  log: [],
  polls: 0,
});

export const makeStore = (initial: DashboardState): Store => {
  let state = initial;
  const subscribers = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    update: (fn) => {
      state = fn(state);
      for (const onChange of subscribers) onChange();
    },
  };
};

const LOG_TAIL = 200;
const ACTIVE: ReadonlySet<Status> = new Set(["claiming", "provisioning", "implementing", "failed"]);

// --- pure reducers (used by the tui reporter / console override) ------------

export const applyLog = (state: DashboardState, line: string): DashboardState => ({
  ...state,
  log: [...state.log, line].slice(-LOG_TAIL),
});

export const applyFocus = (state: DashboardState, focused: number | undefined): DashboardState => ({
  ...state,
  focused,
  log: [],
});

export const applyStatus = (
  state: DashboardState,
  row: { number: number; title: string; status: Status; step?: string; pane?: string },
): DashboardState => {
  const existing = state.rows[row.number];
  return {
    ...state,
    rows: {
      ...state.rows,
      [row.number]: {
        ...existing,
        number: row.number,
        title: row.title,
        status: row.status,
        step: row.step ?? existing?.step,
        pane: row.pane ?? existing?.pane,
        ...(row.status === "finished" ? { finishedAt: Date.now() } : {}),
      },
    },
  };
};

// Reconcile a poll: rebuild the queued set, surface wip issues we aren't already
// tracking with a finer status, and flag newly-pulled-in issues. Never downgrades
// a row githog is actively driving (claiming/provisioning/implementing).
export const applyPoll = (
  state: DashboardState,
  poll: {
    queued: ReadonlyArray<{ number: number; title: string }>;
    active: number;
    newNumbers: ReadonlyArray<number>;
    finishedNumbers: ReadonlyArray<number>;
  },
): DashboardState => {
  const next: Record<number, IssueRow> = {};
  const newSet = new Set(poll.newNumbers);

  // Carry over active + finished rows githog is tracking.
  for (const row of Object.values(state.rows)) {
    if (ACTIVE.has(row.status) || row.status === "finished") {
      next[row.number] = { ...row, isNew: false };
    }
  }
  // Newly-finished: move out of active into finished.
  for (const number of poll.finishedNumbers) {
    const row = state.rows[number];
    if (row !== undefined) next[number] = { ...row, status: "finished", finishedAt: Date.now(), isNew: false };
  }
  // Queued (label present, not yet claimed). Don't clobber an active row.
  for (const item of poll.queued) {
    const existing = next[item.number];
    if (existing !== undefined && ACTIVE.has(existing.status)) continue;
    next[item.number] = {
      number: item.number,
      title: item.title,
      status: "queued",
      isNew: newSet.has(item.number),
    };
  }

  return { ...state, activeCount: poll.active, rows: next, polls: state.polls + 1 };
};
