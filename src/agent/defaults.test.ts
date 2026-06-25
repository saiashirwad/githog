import { expect, test } from "bun:test";
import { resolveCommand } from "./defaults.ts";

const ctx = { item: { number: 3, title: "t" }, args: ["--foo"] } as any;

test("resolveCommand passes array through", () => {
  expect(resolveCommand(["claude"], ctx)).toEqual(["claude"]);
});
test("resolveCommand calls function with ctx", () => {
  expect(resolveCommand((c: any) => ["claude", "--model", c.item.number === 3 ? "opus" : "sonnet"], ctx))
    .toEqual(["claude", "--model", "opus"]);
});
test("resolveCommand defaults to ['claude']", () => {
  expect(resolveCommand(undefined, ctx)).toEqual(["claude"]);
});
