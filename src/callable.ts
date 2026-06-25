/** Resolve a config value that may be a plain value, a `(ctx) => value` callback, or absent. */
export const resolveCallable = <C, R>(
  cfg: R | ((ctx: C) => R) | undefined,
  ctx: C,
  fallback: R,
): R =>
  // `typeof cfg === "function"` cannot narrow `R | function` when `R` is an
  // unconstrained generic, so one localized cast lives here (and only here).
  typeof cfg === "function" ? (cfg as (ctx: C) => R)(ctx) : (cfg ?? fallback);
