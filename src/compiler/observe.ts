/**
 * Observation: everything the compiler is allowed to know about a site.
 *
 * The model never sees the live site and never drives a browser. It sees this
 * object, once. Keeping the boundary here is what makes a compile reproducible
 * and what keeps the prompt small enough to be cheap.
 */
import { pilotError } from "../shared/errors.js";

export interface JsonCandidate {
  url: string;
  status: number;
  /** First few records, trimmed. Enough to infer paths, not enough to blow up the prompt. */
  sample: unknown;
}

export interface Observation {
  url: string;
  /** JSON responses the page itself fetched — the best case for a compile. */
  json: JsonCandidate[];
  /** Rendered DOM, trimmed to the repeating region. Used when there is no JSON. */
  dom: { title: string; html: string; text: string } | null;
}

const MAX_JSON_SAMPLE_RECORDS = 3;
const MAX_HTML_CHARS = 60_000;
const MAX_CANDIDATES = 8;

/** Keep the first few records of any array we find, so the prompt stays bounded. */
function trimSample(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_JSON_SAMPLE_RECORDS).map((item) => trimSample(item, depth + 1));
  }
  if (value && typeof value === "object" && depth < 4) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimSample(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 400) return `${value.slice(0, 400)}…`;
  return value;
}

/**
 * Load the page in a real browser and record both the JSON it fetches and the
 * DOM it renders. Sites that are JSON underneath compile into an `http-json`
 * recipe that never needs a browser again; the rest compile into a `browser`
 * recipe.
 */
export async function observe(
  url: string,
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<Observation> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const json: JsonCandidate[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("response", (response) => {
      if (json.length >= MAX_CANDIDATES) return;
      const type = response.headers()["content-type"] ?? "";
      if (!type.includes("json")) return;
      void response
        .json()
        .then((body: unknown) => {
          if (json.length >= MAX_CANDIDATES) return;
          // Only endpoints that actually carry a list of things are useful.
          if (!containsArray(body)) return;
          json.push({ url: response.url(), status: response.status(), sample: trimSample(body) });
        })
        .catch(() => undefined);
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 });
    } catch (cause) {
      throw pilotError("OBSERVATION_FAILED", `Could not load ${url}: ${(cause as Error).message}`);
    }

    // Then give client-rendered listings a chance to arrive. Plenty of real
    // sites hold a socket open forever, so a quiet network is a best effort and
    // never a requirement — waiting on it outright loses pages that did load.
    await page
      .waitForLoadState("networkidle", { timeout: options.settleMs ?? 8_000 })
      .catch(() => undefined);

    const dom = {
      title: await page.title(),
      html: (await page.content()).slice(0, MAX_HTML_CHARS),
      text: (await page.innerText("body")).slice(0, 20_000),
    };

    return { url, json, dom };
  } finally {
    await browser.close();
  }
}

function containsArray(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return value.length > 0 && typeof value[0] === "object";
  if (value && typeof value === "object" && depth < 3) {
    return Object.values(value as Record<string, unknown>).some((item) => containsArray(item, depth + 1));
  }
  return false;
}
