// Pure argv/dotenv/templating helpers — no Effect, no IO. Lifted from
// worktree-setup.ts so they stay unit-testable in isolation.

// Branch/worktree name -> a slug safe for identifiers and paths: lowercase,
// non-alphanumerics collapsed to '_', trimmed. (worktree-setup used this for the
// per-worktree database name; here it also seeds the worktree dir + herdr label.)
export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

// Read a single KEY=value out of dotenv text (ignores comments/blank lines).
export const readEnvVar = (content: string, key: string): string | undefined => {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return undefined;
};

// Set KEY=value in place — replacing an existing line (even a commented
// "# KEY=…"), else appending. Keeps the source file's comments/secrets intact;
// only the keys we own move.
export const setEnvVar = (lines: ReadonlyArray<string>, key: string, value: string): Array<string> => {
  const pattern = new RegExp(`^#?\\s*${key}=`);
  const next = [...lines];
  const index = next.findIndex((line) => pattern.test(line));
  if (index === -1) {
    next.push(`${key}=${value}`);
  } else {
    next[index] = `${key}=${value}`;
  }
  return next;
};

// Lowest port >= base not already claimed by a sibling worktree's .env.
export const nextFreePort = (base: number, used: ReadonlySet<number>): number => {
  let port = base;
  while (used.has(port)) port += 1;
  return port;
};

// Substitute {{slug}}, {{branch}}, … and {{env:KEY}} tokens in a setup-step argv
// element. Unknown tokens are left intact (so a literal {{x}} survives).
export const applyTemplate = (
  value: string,
  vars: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>,
): string =>
  value
    .replace(/\{\{env:([A-Za-z0-9_]+)\}\}/g, (match, key: string) => env[key] ?? match)
    .replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => vars[key] ?? match);
