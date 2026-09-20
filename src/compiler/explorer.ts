/**
 * The browser the model explores with.
 *
 * Every tool here is deliberately narrow and returns a small, textual result.
 * The model cannot see the page — it can only ask questions about it — so each
 * answer has to be informative and bounded. This is the difference between
 * "guess a selector from a wall of HTML" and "test a selector and see what it
 * actually matched".
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface CapturedRequest {
  url: string;
  status: number;
  /** Trimmed body, only for responses that look like they carry records. */
  sample: string;
}

export interface Explorer {
  goto(url: string): Promise<string>;
  find(selector: string, limit: number): Promise<string>;
  fill(selector: string, value: string): Promise<string>;
  click(selector: string): Promise<string>;
  evaluate(code: string): Promise<string>;
  requests(): string;
  currentUrl(): string;
  close(): Promise<void>;
}

const MAX_RESULT_CHARS = 6_000;

function clip(text: string, max = MAX_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export async function openExplorer(options: { headless?: boolean } = {}): Promise<Explorer> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  const captured: CapturedRequest[] = [];
  /** `--watch` only. Every selector the model tries is invisible otherwise. */
  const visible = options.headless === false;

  /**
   * Outline what a selector matched, for a person watching the window.
   *
   * Done with a stylesheet keyed on the model's own selector rather than by
   * setting styles or classes on the elements, so nothing an element reports
   * about itself changes. `find` hands the model each match's `outerHTML`, and
   * a later step may read `document.body.innerHTML` wholesale — an injected
   * attribute would end up in both, and a selector written against it would be
   * a selector for a highlight that only exists while someone is watching.
   * A `<style>` in the head appears in neither.
   */
  async function show(selector: string): Promise<void> {
    if (!visible) return;
    try {
      await page.$$eval(selector, (elements) =>
        elements[0]?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      const style = await page.addStyleTag({
        content: `${selector} { outline: 3px solid #ff3b30 !important; outline-offset: 2px; }`,
      });
      await page.waitForTimeout(700);
      await style.evaluate((node) => node.remove());
    } catch {
      // Cosmetic. A selector that cannot be highlighted still gets reported.
    }
  }

  // Record JSON traffic as the model navigates. If the site turns out to be
  // JSON underneath, the script it writes can skip the browser entirely.
  page.on("response", (response) => {
    if (captured.length >= 25) return;
    const type = response.headers()["content-type"] ?? "";
    if (!type.includes("json")) return;
    void response
      .text()
      .then((body) => {
        if (captured.length >= 25 || body.length < 200) return;
        captured.push({ url: response.url(), status: response.status(), sample: clip(body, 1_500) });
      })
      .catch(() => undefined);
  });

  return {
    currentUrl: () => page.url(),

    async goto(url: string) {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        const title = await page.title();
        const text = await page.innerText("body").catch(() => "");
        return clip(
          `status: ${response?.status() ?? "unknown"}\nurl: ${page.url()}\ntitle: ${title}\n\nvisible text:\n${text}`,
          5_000,
        );
      } catch (cause) {
        return `navigation failed: ${(cause as Error).message}`;
      }
    },

    /**
     * Test a selector. Reports how many elements matched and what the first few
     * look like — the core "does this extraction work" question.
     */
    async find(selector: string, limit: number) {
      try {
        const results = await page.$$eval(
          selector,
          (elements, max) =>
            elements.slice(0, max).map((element) => ({
              text: (element as { innerText?: string }).innerText?.slice(0, 200) ?? "",
              html: element.outerHTML.slice(0, 400),
              href: (element as { href?: string }).href ?? null,
            })),
          Math.min(limit || 3, 5),
        );
        const total = await page.$$eval(selector, (elements) => elements.length);
        if (total === 0) return `0 elements matched "${selector}"`;
        // After the results are read, never before: highlighting is for the
        // person watching, and must not reach what the model is told.
        await show(selector);
        return clip(`${total} elements matched "${selector}". First ${results.length}:\n${JSON.stringify(results, null, 2)}`);
      } catch (cause) {
        return `invalid selector "${selector}": ${(cause as Error).message}`;
      }
    },

    async fill(selector: string, value: string) {
      try {
        await page.fill(selector, value, { timeout: 10_000 });
        return `filled "${selector}" with "${value}"`;
      } catch (cause) {
        return `could not fill "${selector}": ${(cause as Error).message}`;
      }
    },

    async click(selector: string) {
      try {
        await page.click(selector, { timeout: 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        return `clicked "${selector}"\nurl is now: ${page.url()}`;
      } catch (cause) {
        return `could not click "${selector}": ${(cause as Error).message}`;
      }
    },

    /**
     * Run a snippet in the page and see what comes back. This is how the model
     * tests a whole extraction before committing to it — the snippet it proves
     * here is usually the body of the script it submits.
     */
    async evaluate(code: string) {
      try {
        const result = await page.evaluate<unknown, string>(
          (source) => {
            // eslint-disable-next-line no-new-func
            const fn = new Function(`return (${source})`)();
            return typeof fn === "function" ? fn() : fn;
          },
          code,
        );
        return clip(`result:\n${JSON.stringify(result, null, 2)}`);
      } catch (cause) {
        return `evaluate failed: ${(cause as Error).message}`;
      }
    },

    requests() {
      if (captured.length === 0) return "No JSON responses captured yet. Navigate first.";
      return clip(
        captured
          .map((item) => `--- ${item.url} (HTTP ${item.status})\n${item.sample}`)
          .join("\n\n"),
        8_000,
      );
    },

    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}

