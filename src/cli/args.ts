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
