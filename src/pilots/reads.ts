/**
 * Which query keys does a compiled script read?
 *
 * Reported as a false accusation, on the tool whose job is deciding whether to
 * recompile: the first version matched `query.foo` and nothing else, so
 * `const { origin } = query` was announced as "ignores its query". Being wrong
 * in that direction is the worst option available — it sends someone to
 * recompile a working Pilot, and it discredits the finding when the Pilot
 * really is hardcoded.
 *
 * This is still a regex over source, which cannot be complete. So it reports
 * how sure it is, and the uncertain case says so instead of accusing. The
 * authoritative answer is the probe recorded in `evidence.probe`, which is
 * measured by running the script rather than by reading it.
 */

export type ReadConfidence = "exact" | "uncertain" | "none";

export interface QueryReads {
  keys: string[];
  confidence: ReadConfidence;
  /** Why the answer is uncertain, when it is. */
  note: string | null;
}

/** `query.origin`, `query["origin"]`, `query?.origin` */
const MEMBER = /query\s*\??\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\])/g;

/** `const { a, b: c, ...rest } = query` — the names on the left. */
const DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*query\b/g;

/** `function search(page, { origin, destination })` — destructured in place. */
const SIGNATURE = /function\s+search\s*\(\s*[^,)]*,\s*\{([^}]*)\}/;

/** `const q = query` — anything reached through `q` is reached through query. */
const ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*query\b\s*[;\n]/g;

/** Names bound by a destructuring pattern, ignoring defaults and renames. */
function namesIn(pattern: string): string[] {
  return pattern
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("..."))
    .map((part) => part.split(":")[0]!.split("=")[0]!.trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

export function queryReads(code: string): QueryReads {
  const keys = new Set<string>();

  for (const match of code.matchAll(MEMBER)) keys.add(match[1] ?? match[2]!);
  for (const match of code.matchAll(DESTRUCTURE)) for (const name of namesIn(match[1]!)) keys.add(name);

  const signature = SIGNATURE.exec(code);
  if (signature) for (const name of namesIn(signature[1]!)) keys.add(name);

  // An alias means anything reached through that name is reached through the
  // query, so look for its members too.
  const aliases = [...code.matchAll(ALIAS)].map((match) => match[1]!);
  for (const alias of aliases) {
    const pattern = new RegExp(
      `\\b${alias}\\s*\\??\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*["']([^"']+)["']\\s*\\])`,
      "g",
    );
    for (const match of code.matchAll(pattern)) keys.add(match[1] ?? match[2]!);
  }

  const found = [...keys].sort();
  if (found.length > 0) {
    return { keys: found, confidence: "exact", note: null };
  }

  // No keys, but the query is touched somehow — spread into a URL, passed on,
  // indexed by a computed name. Something is happening; this cannot say what.
  if (/\bquery\b/.test(code)) {
    return {
      keys: [],
      confidence: "uncertain",
      note:
        "The script mentions `query` but this check could not tell which keys it " +
        "reads — a computed index or a spread, most likely. See evidence.probe, " +
        "which is measured by running the script rather than reading it.",
    };
  }

  return {
    keys: [],
    confidence: "none",
    note: "The script never mentions `query`, so it returns the same records for every request.",
  };
}
