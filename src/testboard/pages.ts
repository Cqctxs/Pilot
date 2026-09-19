import { type TestJob } from "./data.js";

/**
 * Two layouts of the same catalogue.
 *
 * Layout A is a card list; layout B is a table with different class names and a
 * different DOM nesting. A Pilot compiled against one does not work against the
 * other — which is exactly the controlled break used to exercise `pilot repair`.
 */
export type Layout = "a" | "b";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

const STYLE = [
  "body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem;color:#111}",
  "h1{font-size:1.4rem;margin:0 0 1.5rem}form{margin-bottom:2rem;display:flex;gap:.5rem}",
  "input{padding:.5rem;border:1px solid #ccc;border-radius:4px}button{padding:.5rem 1rem}",
  ".job-card{border:1px solid #e3e3e3;border-radius:6px;padding:1rem;margin-bottom:.75rem}",
  ".job-card h2{font-size:1rem;margin:0 0 .25rem}.meta{color:#555;font-size:.85rem}",
  "table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #e3e3e3}",
].join("\n");

export function renderSearchPage(
  jobs: TestJob[],
  layout: Layout,
  keywords: string,
  location: string,
): string {
  const body = layout === "a" ? renderCards(jobs) : renderTable(jobs);
  const empty = '<p class="no-results">No roles match your search.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test Board — Open roles</title><style>${STYLE}</style></head>
<body>
  <h1>Open roles</h1>
  <form method="get" action="/jobs">
    <input name="q" placeholder="Keywords" value="${escapeHtml(keywords)}">
    <input name="loc" placeholder="Location" value="${escapeHtml(location)}">
    <button type="submit">Search</button>
  </form>
  <p class="result-count">${jobs.length} result${jobs.length === 1 ? "" : "s"}</p>
  ${jobs.length === 0 ? empty : body}
</body></html>`;
}

function renderCards(jobs: TestJob[]): string {
  return jobs
    .map(
      (job) => `  <article class="job-card">
    <h2><a href="/jobs/${job.id}">${escapeHtml(job.title)}</a></h2>
    <p class="meta"><span class="company">${escapeHtml(job.company)}</span>
      <span class="location">${escapeHtml(job.location ?? "")}</span>
      <span class="type">${escapeHtml(job.employmentType ?? "")}</span>
      <time datetime="${job.postedAt}">${job.postedAt}</time></p>
  </article>`,
    )
    .join("\n");
}

function renderTable(jobs: TestJob[]): string {
  const rows = jobs
    .map(
      (job) => `    <tr class="posting">
      <td class="posting-title"><a href="/jobs/${job.id}">${escapeHtml(job.title)}</a></td>
      <td class="posting-org">${escapeHtml(job.company)}</td>
      <td class="posting-where">${escapeHtml(job.location ?? "—")}</td>
      <td class="posting-kind">${escapeHtml(job.employmentType ?? "—")}</td>
      <td class="posting-date">${job.postedAt}</td>
    </tr>`,
    )
    .join("\n");
  return `<table class="postings">
    <thead><tr><th>Role</th><th>Organisation</th><th>Where</th><th>Kind</th><th>Posted</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

export function renderJobPage(job: TestJob): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(job.title)}</title><style>${STYLE}</style></head>
<body><h1>${escapeHtml(job.title)}</h1>
<p class="meta">${escapeHtml(job.company)} · ${escapeHtml(job.location ?? "Location not specified")}</p>
<p><a href="/jobs">Back to all roles</a></p></body></html>`;
}
