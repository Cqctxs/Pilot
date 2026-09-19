import { pilotError } from "../shared/errors.js";

/**
 * Fill `{name}` placeholders. Unknown variables resolve to the empty string so
 * a recipe written for `{keywords}` still works for an unfiltered listing.
 */
export function fillTemplate(template: string, variables: Record<string, string | number>): string {
  return template.replace(/\{([a-z][a-zA-Z0-9]*)\}/g, (_match, name: string) => {
    const value = variables[name];
    return value === undefined ? "" : String(value);
  });
}

export function fillUrl(template: string, variables: Record<string, string | number>): string {
  const filled = fillTemplate(template, {
    ...Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [key, encodeURIComponent(String(value))]),
    ),
  });
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    throw pilotError("INVALID_RECIPE", `Recipe produced an invalid URL: ${filled}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw pilotError("INVALID_RECIPE", `Recipe URL must be http(s): ${filled}`);
  }
  return url.toString();
}
