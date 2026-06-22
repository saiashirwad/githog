import { useKeyboard } from "@opentui/react";
import { useSyncExternalStore } from "react";
import type { DashboardState, IssueRow, Status, Store } from "./store.ts";

// NOTE: OpenTUI <text> accepts ONLY string children — no nested <text>, no raw
// numbers. So every <text> here gets exactly one template-string child, and we
// colour whole lines via `fg` rather than styling inline segments.

const GLYPH: Record<Status, string> = {
  queued: "·",
  claiming: "◌",
  provisioning: "⟳",
  implementing: "▸",
  finished: "✓",
  failed: "✗",
};
const COLOR: Record<Status, string> = {
  queued: "#8a8a8a",
  claiming: "#e5c07b",
  provisioning: "#e5c07b",
  implementing: "#56b6c2",
  finished: "#98c379",
  failed: "#e06c75",
};

const ACTIVE: ReadonlySet<Status> = new Set(["claiming", "provisioning", "implementing", "failed"]);

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function IssueLine({ row }: { row: IssueRow }) {
  const suffix = row.step ? ` · ${row.step}` : row.isNew ? " NEW" : "";
  return <text fg={COLOR[row.status]}>{`${GLYPH[row.status]} #${row.number} ${truncate(row.title, 22)}${suffix}`}</text>;
}

function Column({ title, rows }: { title: string; rows: ReadonlyArray<IssueRow> }) {
  return (
    <box flexGrow={1} flexDirection="column" border borderStyle="rounded" title={`${title} (${rows.length})`} padding={1}>
      {rows.length === 0 ? <text fg="#5c5c5c">—</text> : rows.map((row) => <IssueLine key={row.number} row={row} />)}
    </box>
  );
}

export function Dashboard({ store, onQuit }: { store: Store; onQuit: () => void }) {
  const state: DashboardState = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") onQuit();
  });

  const all = Object.values(state.rows);
  const queued = all.filter((r) => r.status === "queued").sort((a, b) => a.number - b.number);
  const inProgress = all.filter((r) => ACTIVE.has(r.status)).sort((a, b) => a.number - b.number);
  const done = all
    .filter((r) => r.status === "finished")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 8);

  const focused = state.focused === undefined ? undefined : state.rows[state.focused];
  const logTail = state.log.slice(-12);

  const headerLine = `${state.repoName} · trigger ${state.readyLabel} · every ${state.intervalSeconds}s · ${state.activeCount}/${state.maxConcurrent} active · ${state.polls} polls`;
  const detailHead = focused
    ? `${GLYPH[focused.status]} ${focused.status}${focused.step ? ` · ${focused.step}` : ""}${focused.pane ? ` · pane ${focused.pane}` : ""}`
    : "idle — waiting for the next ready issue";

  return (
    <box flexDirection="column" height="100%">
      <box border borderStyle="rounded" title="homestead listen" padding={1}>
        <text fg={state.activeCount >= state.maxConcurrent ? "#e5c07b" : "#abb2bf"}>{headerLine}</text>
        {state.error ? <text fg="#e06c75">{`error: ${truncate(state.error, 110)}`}</text> : null}
      </box>

      <box flexDirection="row" flexGrow={1}>
        <Column title="QUEUED" rows={queued} />
        <Column title="IN PROGRESS" rows={inProgress} />
        <Column title="DONE" rows={done} />
      </box>

      <box
        border
        borderStyle="rounded"
        title={focused ? `detail · #${focused.number}` : "detail"}
        height={16}
        flexDirection="column"
        padding={1}
      >
        <text fg={focused ? COLOR[focused.status] : "#5c5c5c"}>{detailHead}</text>
        {logTail.map((line, i) => (
          <text key={i} fg="#9a9a9a">
            {truncate(line, 120)}
          </text>
        ))}
      </box>

      <text fg="#5c5c5c">q quit · agents run in their own herdr worktree panes</text>
    </box>
  );
}
