import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { TrackingStateSchema } from "./tracking.ts";

test("TrackingState decodes legacy state without title/worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const legacy = decode({ number: 7, url: "u", label: "agent:wip" });
  expect(legacy.number).toBe(7);
  expect(legacy.title).toBeUndefined();
  expect(legacy.worktreeDir).toBeUndefined();
});

test("TrackingState round-trips title + worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const s = decode({ number: 7, url: "u", title: "Fix bug", worktreeDir: "/tmp/wt" });
  expect(s.title).toBe("Fix bug");
  expect(s.worktreeDir).toBe("/tmp/wt");
});

test("tracking state encode/decode round-trip", async () => {
  const state = {
    number: 42,
    url: "https://github.com/o/r/issues/42",
    label: "agent:working",
    assigned: true,
    commented: true,
  };
  const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(TrackingStateSchema)(state));
  const json = JSON.stringify(encoded);
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(json),
  );
  expect(decoded).toEqual(state);
});
