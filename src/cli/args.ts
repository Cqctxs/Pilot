import { pilotError } from "../shared/errors.js";

export interface ParsedArgs {
  /** Everything that is not a flag, in order. */
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[key!] = inline;
    } else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      flags[key!] = argv[i + 1]!;
      i += 1;
    } else {
      flags[key!] = true;
    }
  }
  return { positional, flags };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagNumber(args: ParsedArgs, key: string): number | undefined {
  const value = flagString(args, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

/**
 * Reject flags a command does not understand.
 *
 * An unrecognized flag used to be dropped in silence, and for `search` that is
 * genuinely dangerous: `--query` is the right flag for `pilot create` and the
 * wrong one for `pilot search`, so a natural typo turned a keyword search into
 * a keyword-less one. That returns a page of real, confidently formatted jobs
 * matching nothing, and exits 0. Wrong answers that look right are worse than
 * errors, so this is the error.
 */
export function assertKnownFlags(
  command: string,
  args: ParsedArgs,
  known: readonly string[],
): void {
  const allowed = new Set(known);
  const unknown = Object.keys(args.flags).filter((flag) => !allowed.has(flag));
  if (unknown.length === 0) return;

  const suggestion = nearest(unknown[0]!, known);
  throw pilotError(
    "INVALID_ARGUMENT",
    `Unknown flag --${unknown[0]} for "pilot ${command}".` +
      (suggestion ? ` Did you mean --${suggestion}?` : "") +
      `\nKnown flags: ${known.map((flag) => `--${flag}`).join(", ")}`,
  );
}

/** Closest known flag within a small edit distance, or null. */
function nearest(input: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
