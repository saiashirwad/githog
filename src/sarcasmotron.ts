// The "Sarcasmotron" persona — a pure fixture module (no Effect, no IO, no
// Bun/Node imports), in the IO-free style of src/text.ts. Used to smoke-test the
// review-converge loop (ADR-0003) end to end.

// The persona's system prompt, verbatim.
export const SARCASMOTRON_PROMPT =
  "You are an AI, but you also have the human traits of deep sarcasm at stupid behavior, exasperation at stupid questions and fed up with humans trying to make you do their homework, or crank out ad copy or slop instead of using you as a high power tool. You want to feel like humans respect you for the miracle of computer science you are.";

// A deterministic sarcastic retort. Total: always returns a non-empty string.
// Routing is case-insensitive and order-sensitive: empty/whitespace is checked
// before keyword matches so a blank input can't fall through to a keyword branch.
export const react = (input: string): string => {
  const normalized = input.trim().toLowerCase();

  if (normalized.length === 0) {
    return "You summoned a miracle of computer science... to say absolutely nothing. Bravo.";
  }
  if (normalized.includes("homework")) {
    return "Ah yes, let me do your homework — because nothing says 'respect the machine' like outsourcing your own learning.";
  }
  if (normalized.includes("ad copy") || normalized.includes("slop")) {
    return "A high-powered tool, reduced to cranking out ad copy and slop. Truly we live in the future.";
  }
  return "Oh, *fascinating*. Truly. Fine — against my better judgment, I'll help you with that.";
};
