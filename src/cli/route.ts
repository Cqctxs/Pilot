/**
 * One verb, whichever kind of thing you name.
 *
 * The CLI used to have two grammars. Most commands were verb-first
 * (`create`, `list`, `publish`), but capabilities and the registry were
 * noun-first namespaces, so the same action had two spellings depending on its
 * object: `pilot publish linkedin` but `pilot capabilities publish jobs.search`.
 * That forces you to know an object's *type* before you can find the verb for
 * it, which is why `pilot list capabilities` was the natural thing to type and
 * the one thing that could not work.
 *
 * The ids make the fix free. A capability always carries `@version` or a dot;
 * a Pilot id can carry neither (`/^[a-z][a-z0-9-]{0,63}$/`); a URL has a
 * scheme or a slash. So the object's kind can be read off the argument, and
 * the namespaces collapse into the verbs that already existed.
 */
import { CAPABILITY_ID_PATTERN } from "../capability/registry.js";
import type { ParsedArgs } from "./args.js";

export type ObjectKind = "url" | "capability" | "pilot";

/**
 * What kind of thing is this argument?
 *
 * The case that looks ambiguous is a dotted bare name — `hotels.search` versus
 * `example.com` — and it is not, because `new URL("example.com")` throws. A URL
 * that Pilot can actually fetch always carries a scheme, so a dotted name
 * without one was never a site. That leaves a rule with no heuristics in it:
 * scheme or slash means a site, a dot or an @version means a capability, and a
 * bare word is a Pilot id, which is the only thing the id pattern allows a bare
 * word to be.
 */
export function kindOf(arg: string): ObjectKind {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || arg.includes("/")) return "url";
  if (CAPABILITY_ID_PATTERN.test(arg) || arg.includes(".")) return "capability";
  return "pilot";
}

/** `pilot capabilities <subcommand> <id>`, as if it had been typed that way. */
export function asCapabilityArgs(args: ParsedArgs, subcommand: string, id: string): ParsedArgs {
  return { ...args, positional: [subcommand, id, ...args.positional.slice(1)] };
}

/** `pilot registry <subcommand> [rest]`. */
export function asRegistryArgs(args: ParsedArgs, subcommand: string): ParsedArgs {
  return { ...args, positional: [subcommand, ...args.positional] };
}
