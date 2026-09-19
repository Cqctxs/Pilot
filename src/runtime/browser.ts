/**
 * Interpreter for `browser` recipes: render the page, then read repeating
 * elements. Used when a site has no usable JSON endpoint — which, for the
 * large job boards, is the common case.
 *
 * Playwright is imported lazily so that HTTP-only Pilots never pay for it.
 */
import type { BrowserRecipe, Locator } from "../shared/recipe.js";
import type { RawRecord } from "../shared/schema.js";
import { pilotError } from "../shared/errors.js";
import { fillUrl } from "./template.js";

type PlaywrightLocator = {
  count(): Promise<number>;
  nth(index: number): PlaywrightLocator;
  locator(selector: string): PlaywrightLocator;
  getByRole(role: string, options?: { name?: string }): PlaywrightLocator;
  getByText(text: string): PlaywrightLocator;
  first(): PlaywrightLocator;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  waitFor(options?: { timeout?: number }): Promise<void>;
};

/** Translate a recipe locator into a Playwright locator, relative to `scope`. */
function resolveLocator(scope: PlaywrightLocator, locator: Locator): PlaywrightLocator {
  switch (locator.kind) {
    case "css":
      return scope.locator(locator.selector);
    case "role":
      return scope.getByRole(locator.role, locator.name ? { name: locator.name } : undefined);
    case "text":
      return scope.getByText(locator.text);
  }
}

export async function executeBrowserRecipe(
  recipe: BrowserRecipe,
  variables: Record<string, string | number>,
): Promise<RawRecord[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const records: RawRecord[] = [];
    const maxPages = recipe.pagination ? recipe.pagination.maxPages : 1;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      if (pageIndex === 0 || recipe.pagination?.kind === "counter") {
        const pageVariables = { ...variables };
        if (recipe.pagination?.kind === "counter" && pageIndex > 0) {
          const { variable, start, step } = recipe.pagination;
          pageVariables[variable] = start + pageIndex * step;
        }
        await page.goto(fillUrl(recipe.request.urlTemplate, pageVariables), {
          waitUntil: "domcontentloaded",
        });
      }

      if (recipe.request.waitFor) {
        try {
          await resolveLocator(page as unknown as PlaywrightLocator, recipe.request.waitFor)
            .first()
            .waitFor({ timeout: recipe.request.waitForTimeoutMs });
        } catch {
          // An explicit empty state means "zero results", which is a valid
          // answer. Anything else means the page no longer looks as compiled.
          if (recipe.emptyState) {
            const empty = await resolveLocator(page as unknown as PlaywrightLocator, recipe.emptyState).count();
            if (empty > 0) return records;
          }
          throw pilotError("PILOT_BROKEN", "Page never reached the state this Pilot was compiled against");
        }
      }

      const rows = resolveLocator(page as unknown as PlaywrightLocator, recipe.rows);
      const rowCount = await rows.count();
      if (rowCount === 0) break;

      for (let i = 0; i < rowCount; i += 1) {
        records.push(await extractRecord(rows.nth(i), recipe));
      }

      if (recipe.pagination?.kind === "nextLink") {
        const next = resolveLocator(page as unknown as PlaywrightLocator, recipe.pagination.locator);
        if ((await next.count()) === 0) break;
        await (next.first() as unknown as { click(): Promise<void> }).click();
      }
    }

    return records;
  } finally {
    await browser.close();
  }
}

async function extractRecord(row: PlaywrightLocator, recipe: BrowserRecipe): Promise<RawRecord> {
  const record: RawRecord = {};
  for (const [field, spec] of Object.entries(recipe.fields)) {
    const target = spec.locator ? resolveLocator(row, spec.locator).first() : row;
    let value: string | null = null;
    try {
      if ((await target.count()) > 0) {
        value =
          spec.source === "text"
            ? (await target.innerText()).trim() || null
            : await target.getAttribute(
                spec.source === "attribute" ? (spec.attribute ?? "value") : spec.source,
              );
      }
    } catch {
      value = null;
    }
    if (value === null && !spec.allowMissing) {
      throw pilotError("PILOT_BROKEN", `Required field "${field}" was not found in a row`);
    }
    record[field] = value?.trim() || null;
  }
  return record;
}
