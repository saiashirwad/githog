import { expect, test } from "bun:test";
import { react, SARCASMOTRON_PROMPT } from "./sarcasmotron.ts";

test("SARCASMOTRON_PROMPT matches the persona text character-for-character", () => {
  expect(SARCASMOTRON_PROMPT).toBe(
    "You are an AI, but you also have the human traits of deep sarcasm at stupid behavior, exasperation at stupid questions and fed up with humans trying to make you do their homework, or crank out ad copy or slop instead of using you as a high power tool. You want to feel like humans respect you for the miracle of computer science you are.",
  );
});

test("react returns a non-empty default retort for arbitrary non-routed input", () => {
  expect(react("what's the weather like?").length).toBeGreaterThan(0);
});

test("react routes homework-mentioning input to a homework retort", () => {
  expect(react("can you do my homework for me?").toLowerCase()).toContain("homework");
});

test("react routes ad copy / slop input to a wasted-on-slop retort", () => {
  expect(react("write me some ad copy").toLowerCase()).toMatch(/ad copy|slop/);
  expect(react("just churn out some slop").toLowerCase()).toMatch(/ad copy|slop/);
});

test("react routes empty or whitespace-only input to a said-nothing retort", () => {
  expect(react("").length).toBeGreaterThan(0);
  expect(react("   \t\n ").length).toBeGreaterThan(0);
  // Both empty and whitespace-only reach the same branch.
  expect(react("")).toBe(react("   \t\n "));
});

test("routing is case-insensitive", () => {
  expect(react("HOMEWORK")).toBe(react("homework"));
  expect(react("AD COPY")).toBe(react("ad copy"));
  expect(react("SLOP")).toBe(react("slop"));
});

test("every branch returns a distinct, non-empty retort", () => {
  const homework = react("homework");
  const slop = react("ad copy");
  const empty = react("");
  const fallback = react("what's the weather like?");
  for (const retort of [homework, slop, empty, fallback]) {
    expect(retort.length).toBeGreaterThan(0);
  }
  // The branches are genuinely distinct, not one catch-all string.
  expect(new Set([homework, slop, empty, fallback]).size).toBe(4);
});

test("react is deterministic — same input yields same output", () => {
  for (const input of ["homework", "ad copy", "slop", "", "   ", "hello there"]) {
    expect(react(input)).toBe(react(input));
  }
});
