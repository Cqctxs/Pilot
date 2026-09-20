/**
 * A local job board, used to test the compiler against a site whose behaviour
 * we control: no rate limits, no bot detection, and a layout we can change on
 * purpose to verify that `pilot repair` really repairs.
 *
 * Built on node:http — no framework, nothing to install.
 */
import { createServer, type Server } from "node:http";
import { TEST_JOBS, searchJobs } from "./data.js";
import { renderHostilePage, renderJobPage, renderSearchPage, type Layout } from "./pages.js";

export interface TestBoardOptions {
  port: number;
  layout: Layout;
  host?: string;
  /**
   * Serve the listing the way a hostile real site does: results injected by
   * script after a delay, so a script that reads the page on domcontentloaded
   * alone gets zero rows. Used to measure whether a compiled script waits for
   * the data it reads rather than for the network to go quiet.
   */
  hostile?: boolean;
  /** How long the hostile page waits before injecting results. */
  hostileDelayMs?: number;
}

export function startTestBoard(options: TestBoardOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  let boundPort = options.port;
  // An in-flight beacon would also stop the server from ever closing, which
  // would hang every test that starts a board. Track them and cancel on close.
  const pending = new Set<() => void>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
    const keywords = url.searchParams.get("q") ?? "";
    const location = url.searchParams.get("loc") ?? "";

    // A JSON endpoint alongside the HTML, so the board exercises both
    // interpreters. A working compiler should prefer this one.
    if (url.pathname === "/api/jobs") {
      const jobs = searchJobs(keywords, location).map((job) => ({
        ...job,
        url: `http://${host}:${boundPort}/jobs/${job.id}`,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: jobs.length, results: jobs }));
      return;
    }

    const jobMatch = /^\/jobs\/(\d+)$/.exec(url.pathname);
    if (jobMatch) {
      const job = TEST_JOBS.find((item) => item.id === jobMatch[1]);
      if (!job) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderJobPage(job));
      return;
    }

    // Answers slowly, on purpose: the hostile page polls this every 150ms and
    // it takes 800ms to reply, so requests overlap the way ad and analytics
    // chatter does on a real board. Note this does NOT stop Playwright from
    // reaching networkidle — measured, it still settles in ~500ms. Whether a
    // compiled script waits on networkidle is read off the script, not timed.
    if (url.pathname === "/beacon") {
      const slow = setTimeout(() => {
        pending.delete(cancel);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      }, 800);
      const cancel = () => {
        clearTimeout(slow);
        res.destroy();
      };
      pending.add(cancel);
      req.on("close", () => {
        clearTimeout(slow);
        pending.delete(cancel);
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/jobs") {
      const jobs = searchJobs(keywords, location);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        options.hostile
          ? renderHostilePage(jobs, keywords, location, options.hostileDelayMs ?? 800)
          : renderSearchPage(jobs, options.layout, keywords, location),
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  server.on("close", () => {
    for (const cancel of pending) cancel();
    pending.clear();
  });

  return new Promise((resolve) => {
    server.listen(options.port, host, () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolve(server);
    });
  });
}
