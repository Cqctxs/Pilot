/**
 * A local job board, used to test the compiler against a site whose behaviour
 * we control: no rate limits, no bot detection, and a layout we can change on
 * purpose to verify that `pilot repair` really repairs.
 *
 * Built on node:http — no framework, nothing to install.
 */
import { createServer, type Server } from "node:http";
import { TEST_JOBS, searchJobs } from "./data.js";
import { renderJobPage, renderSearchPage, type Layout } from "./pages.js";

export interface TestBoardOptions {
  port: number;
  layout: Layout;
  host?: string;
}

export function startTestBoard(options: TestBoardOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  let boundPort = options.port;
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

    if (url.pathname === "/" || url.pathname === "/jobs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderSearchPage(searchJobs(keywords, location), options.layout, keywords, location));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(options.port, host, () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolve(server);
    });
  });
}
