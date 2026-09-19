# Pilot — specification

Pilot compiles a website into a reusable data API.

Point it at a URL and tell it what data you want. A model explores the site with
a real browser, tests extraction until it works, and writes a script. From then
on that script runs on its own — no model call, no per-request AI cost, no
nondeterminism.

The compiler is the product. Job boards are the first thing we point it at.

---

## 1. Scope

### Build order

**Stage 1 — the compiler.** `pilot create <url>` explores any website and emits a
validated extraction script for an arbitrary set of fields. Capability-agnostic:
`--fields title,price,url` against a shop is as valid a test as a job board.
**Done.**

**Stage 2 — job search at scale.** The `jobs.board@1` capability and Pilots for
real boards — **LinkedIn** and **Talent.com**. The fan-out API: one call, many
boards, merged and deduped. **Done.**

**Stage 3 — controlled testing.** A local board we own, for the things live sites
cannot be asked to do on demand: a true no-match, a changed layout, repair after
a break.

### In scope

| Component | What it is |
| --- | --- |
| Compiler | Explore a site with a browser, write a script, run it for real, retry on failure |
| Artifact | An ES module exporting `search(page, query)`, plus metadata |
| Runtime | Loads and runs a compiled script. No model calls |
| Capability | A named schema plus its normalization rules. `jobs.board@1` is the first |
| SDK | In-process TypeScript API with variadic target selection |
| CLI | `create`, `list`, `enable`/`disable`, `search`, `repair`, `testboard` |
| Test board | A local job board with two layouts, for controlled break-and-repair |

### Not in scope

No web dashboard. No package registry — a compiled Pilot is a file in `pilots/`,
and sharing one is a commit. No authentication; every target is public. No HTTP
server — the SDK and CLI call the runtime in-process. No write operations:
Pilots read data, they do not submit applications.

---

## 2. Architecture

```text
  pilot create <url>                      pilot search / SDK
          │                                        │
          ▼                                        ▼
  ┌───────────────┐                        ┌───────────────┐
  │   COMPILER    │ ── writes a script ──▶ │    RUNTIME    │
  │  (uses a LLM) │                        │ (never does)  │
  └───────┬───────┘                        └───────┬───────┘
          │                                        │
   explore the live site                    load the module,
   → submit → validate → retry              call search()
```

The line between those boxes is the design. A model runs **once**, at compile
time. Everything a user actually waits on is ordinary code.

```text
src/
  shared/      schema, Pilot artifact, errors, env
  compiler/    explorer (browser tools), model client, validate, the loop
  runtime/     loads and runs compiled scripts
  capability/  jobs.board@1: schema, normalization, filtering, dedupe
  pilots/      directory-backed Pilot store
  sdk/         the developer-facing API
  cli/         thin wrapper over the SDK
  testboard/   local job board for controlled tests
```

Dependency rule: `capability/`, `runtime/`, and `sdk/` must never import from
`compiler/`. Searching must not be able to reach a model even by accident.

---

## 3. The capability API

A capability is a named schema plus the normalization that makes results from
different sites comparable. Applications target the capability, never a site.

```ts
import { pilot } from "./src/sdk/index.js";

const jobs = pilot().capability("jobs.board@1");

await jobs.search();                        // every enabled Pilot
await jobs.search("linkedin");              // just LinkedIn
await jobs.search("linkedin", "talent");    // both, merged and deduped
await jobs.search("linkedin", { keywords: "software intern" });
await jobs.search({ keywords: "software intern", location: "Boston" });
```

**Argument rule.** Positional string arguments name Pilots; an optional trailing
object is the query. Both are optional and compose freely.

**Selection rule.** No names means every *enabled* Pilot. Naming a Pilot runs
exactly that one, **whether or not it is enabled** — an explicit request is the
caller's decision, and silently skipping a named target would be worse.

### Result shape

```ts
interface SearchResult {
  jobs: Job[];
  sources: Array<{ pilotId: string; ok: boolean; count: number; durationMs: number; error?: PilotError }>;
}
```

Partial failure is the normal case: LinkedIn rate-limits while Talent answers.
One dead source must never fail the whole search. Sources run concurrently.

### Normalization

1. Records missing a required field are dropped, not half-populated.
2. Employment type is read from the site, falling back to the title, with
   `typeBasis` recording which — so a caller can tell a fact from a guess.
   **One exception, learned from the live boards:** an internship named in the
   title overrides the site's employment type. Both LinkedIn and Talent.com
   report "Software Engineering Intern (Summer)" as `Full-time`, because their
   field means hours per week, not level.
3. Keywords are filtered **locally** after extraction, because sites over-match.
4. Location is **not** filtered locally by default. The query goes to the board,
   which runs a real geographic search; re-checking it as a substring throws away
   correct results — "Boston" legitimately returns Cambridge and Waltham, and
   substring matching discards every one. Opt in with `strictLocation` for a
   source that ignores location entirely.
5. Cross-listed postings are deduped on normalized title + company.

---

## 4. What the compiler emits

An ES module exporting one function, written once and then run on its own:

```js
// pilots/linkedin/1.0.0/extract.mjs
export async function search(page, query) {
  // query: { keywords, location, limit } — any may be empty or null
  return [{ title, company, location, url, employmentType, postedAt }];
}
```

`needsBrowser` in `pilot.json` decides whether Chromium is launched at all. A
script that found a JSON or HTML-fragment endpoint sets it `false` and runs as
plain `fetch`. The LinkedIn Pilot does exactly this — it discovered the guest
`seeMoreJobPostings` fragment endpoint, so a LinkedIn search costs no browser.

### Why a script rather than a declarative recipe

Both run with zero model calls; that is not the difference. A script buys
expressiveness — pagination that fits no pattern, dedupe across pages, falling
back between two markup shapes — at the cost that it cannot be checked without
running it, and that it is model-written code executing with this process's
privileges.

### The trust boundary

Stated plainly: a compiled script is code, and it is executed. It is not
sandboxed. What the runtime does enforce:

- a wall-clock timeout, applied by closing the browser out from under the script;
- a cap of 500 records;
- a shape check on the return value — anything that is not an array of objects is
  a `PILOT_BROKEN` failure, and keys outside the schema are discarded;
- static rejection, before the first run, of `require`, `import`, `process`,
  Node built-ins, and `while (true)`.

A Pilot is a readable file. Read it before trusting it, the same as any
dependency. Running extraction in a child process under the Node permission
model would harden this further; that is a known open item, not a solved
problem.

---

## 5. The compiler

```text
explore → submit script → validate against the live site → retry → save
```

### Explore

The model drives a real browser through a narrow tool surface. It cannot see the
page; it can only ask questions about it, which is why each tool returns a small,
informative answer.

| Tool | What it answers |
| --- | --- |
| `goto` | status, final URL, title, visible text |
| `find` | how many elements a selector matched, and what the first few contain |
| `fill` / `click` | interact — and `click` returns the resulting URL, which is how the search URL pattern gets discovered |
| `evaluate` | run a candidate extraction in the page and see the actual output |
| `requests` | JSON responses the page fetched, with samples |
| `submit_script` | finish |

`evaluate` is the one that matters. It turns "guess a selector from a wall of
HTML" into "test the extraction and look at what came back" — the model iterates
until the output is right, then submits what it proved.

`requests` is what makes a Pilot cheap: if an endpoint carries the records, the
script calls it directly and never launches a browser again.

### Validate

**The gate that separates a compiler from a code generator.** The submitted
script is run for real, and rejected unless:

- it returns at least one record;
- every required field is present on ≥90% of records;
- `url`-typed fields parse as URLs;
- the records are not all identical — which means the row selector matched a
  container rather than the repeating element;
- fewer than half the records are empty — a blocked page often yields junk rows
  rather than an error.

Static checks run first, so a script that uses `require` costs nothing to reject.

### Retry

Rejections go back to the model as a tool result, with the browser **still
open** on the site — it investigates and corrects rather than restarting cold.
Three attempts by default, a 30-step budget. A Pilot is written only after a
real run produces records that satisfy the schema.

### Discovery

The explorer also reports fields the site exposes beyond the schema — salary and
description snippet on Talent.com, seniority and job function on LinkedIn. These
are recorded in `discovered`, **not extracted**. A capability's shape is fixed so
results stay comparable across sources; discovery is how that shape grows later,
deliberately, rather than per-site drift.

### Repair

`pilot repair <id>` first **reproduces the failure** — a Pilot that still works
is left alone, since replacing a known-good script with an unproven one is a
regression. Then it re-explores with the old script and the observed failure as
context. Same validation gate, minor version bump, `repairedFrom` recorded.

---

## 6. Pilot artifacts

`pilots/<id>/<version>/` holds `pilot.json`, the script, and a `sample.json` of
the records that validated it. No registry service, no database: loading is a
directory scan, publishing is a commit, inspecting is `cat`.

```json
{
  "pilotFormatVersion": 2,
  "id": "linkedin",
  "version": "1.0.0",
  "target": { "name": "LinkedIn", "url": "https://www.linkedin.com/jobs/search" },
  "capability": "jobs.board@1",
  "schema": { "...": "copied in, so a Pilot is self-describing" },
  "artifact": { "kind": "script", "entry": "extract.mjs", "needsBrowser": false },
  "discovered": ["seniority level", "job function", "industries"],
  "compiler": { "model": "gpt-5.5", "attempts": 1, "steps": 17, "repairedFrom": null },
  "evidence": { "recordCount": 30, "checkedAt": "...", "sampleFile": "sample.json" }
}
```

The latest version of each Pilot loads. A malformed Pilot warns and is skipped —
it must not take down every other Pilot. `config/pilots.json` holds which Pilots
are enabled, separately from the artifacts, so enabling one never rewrites it.

---

## 7. CLI

```text
pilot create <url> [--id x] [--name x] [--capability jobs.board@1 | --fields a,b,c]
                   [--query text] [--location text] [--attempts n] [--steps n] [--watch]
pilot list [--json]
pilot enable <id> | pilot disable <id>
pilot search [targets...] [--keywords x] [--location x] [--type x] [--limit n]
                          [--strict-location] [--json]
pilot repair <id> [--failure text]
pilot testboard [--port n] [--layout a|b]

pilot publish <id>
pilot install <id>[@version]
pilot registry list | search <text> | versions <id> | health [id]
                          [--capability x] [--limit n] [--json]
pilot mcp
```

`pilot search` mirrors the SDK: positional arguments are Pilot names, flags are
the query. Progress goes to stderr, results to stdout, so `--json` stays
pipeable. Exit is non-zero only when *every* source failed. `--watch` shows the
browser during a compile, which is the fastest way to see why a site is fighting
back. `pilot search` also reports each source's outcome to the registry when one
is configured; `--no-report` opts out.

---

## 8. The registry

Compiling is the expensive step. The registry exists so it is paid once per
site, not once per developer.

```text
pilot publish <id>              push a compiled Pilot
pilot install <id>[@version]    pull one down
pilot registry list
pilot registry search <text>    by site, capability, or field
pilot registry versions <id>
pilot registry health [id]      success rate, worst first
```

Backed by MongoDB, configured by `PILOT_REGISTRY_URI`. **Unset is a supported
state**: without it, publish/install/health report that clearly and every other
command behaves exactly as before. Pilots on disk remain the source of truth;
the registry moves them, it is not a second way to run them.

### 8.1 Why a document store

A Pilot already is a document. Its `schema` block varies per capability, so
there is no fixed table to flatten it into and adding a capability would
otherwise require a migration. One document holds the artifact, the extraction
script, and its provenance.

Two collections:

| Collection | Key | Holds |
| --- | --- | --- |
| `pilots` | `<id>@<version>` | artifact, script source, publisher, denormalized keywords |
| `health` | — | one event per run of a Pilot |

Publishing is a keyed upsert, so republishing a version replaces it rather than
accumulating duplicates. Indexes are created on connect, not by a setup script:
the registry has to work against a database nobody prepared.

`registry search` uses a MongoDB text index over id, summary and keywords, and
falls back to a regex query if that index is missing. Keywords include the
Pilot's `discovered` list — the fields the explorer *saw* but did not extract —
so searching `salary` finds sites that expose salaries even though no capability
carries the field yet.

### 8.2 Health

Every `pilot search` reports per-source outcomes back to the registry,
best-effort and opt-out (`--no-report`). It never blocks or fails a search, and
it is wired at the CLI layer so that `sdk/` and `runtime/` stay free of a
database dependency.

An aggregation turns the event stream into a rolling success rate per version,
sorted worst first — a repair queue rather than a dashboard. It keeps the last
*error* seen rather than the last run's error code; taking the latter lets a
Pilot that fails half the time read as healthy whenever its newest run happened
to succeed.

This is how Pilot learns that a site changed: from the searches people are
already running, not from someone noticing and filing a bug.

---

## 9. MCP

`pilot mcp` serves the same operations to Claude Code, Codex, or any MCP client
over stdio.

| Tool | Notes |
| --- | --- |
| `pilot_list` | Installed Pilots and their fields |
| `pilot_search` | jobs.board@1 across sources, merged |
| `pilot_run` | Any Pilot, raw records — for ad-hoc schemas |
| `pilot_create` | Compile a new site. Slow (minutes). |
| `pilot_repair` | Reproduces the failure first; no-ops if the Pilot still works |
| `pilot_registry_search` | Check before compiling |
| `pilot_install` / `pilot_publish` | Move Pilots between machines |
| `pilot_health` | Worst-first repair queue |

The point is not remote control of the CLI. It is that an agent needing data
from a site with no API can compile a Pilot **once**, and the resulting tool
outlives the conversation — for that agent, and via the registry for every other
one. A browsing agent re-derives the same page every session and pays tokens
each time; this pays at compile time and never again.

Two constraints the implementation has to respect:

- **stdout belongs to JSON-RPC.** The MCP handlers call `compile()` and
  `executePilot()` directly rather than reusing `cli/`, whose functions print.
  One stray write corrupts the stream and the client disconnects.
- **Errors are returned, not thrown.** A thrown error reaches the agent as a
  protocol failure it cannot reason about. `isError` plus the real
  `CODE: message` lets it read what went wrong and choose something else —
  which is also what makes `PILOT_BROKEN` actionable, since the search result
  says outright that `pilot_repair` is the fix.

`pilot_create` and `pilot_repair` stream progress as MCP log notifications and
may exceed a client's default tool timeout.

---

## 10. Errors

The distinction that matters most is between a site being temporarily
unavailable and a Pilot being **wrong**:

| Code | Meaning |
| --- | --- |
| `SOURCE_UNAVAILABLE` / `RATE_LIMITED` / `BLOCKED` | Transient. Retry later; the Pilot is fine |
| `PILOT_BROKEN` | The script no longer matches the site, timed out, or returned the wrong shape. `pilot repair` is the fix |
| `UNKNOWN_PILOT` / `NO_PILOTS_ENABLED` / `INVALID_ARGUMENT` | Caller error |
| `AI_NOT_CONFIGURED` / `AI_REQUEST_FAILED` / `VALIDATION_FAILED` | Compile-time only |
| `REGISTRY_NOT_CONFIGURED` / `REGISTRY_UNAVAILABLE` | Registry only. Never reaches a search — telemetry swallows both |

---

## 11. Test board

`pilot testboard` serves a local job board on port 4100, to test what live sites
cannot be asked to do on demand.

- Both transports: `/api/jobs` returns JSON, `/jobs` renders HTML.
- Two layouts. `--layout a` is a card list; `--layout b` is a table with
  different class names and nesting. A Pilot compiled against one **fails**
  against the other — the controlled break for `pilot repair`.
- Eight postings including the shapes that break naive extractors: a missing
  location, a job whose type appears only in its title, and two postings
  differing only by location.

---

## 12. Completion gates

**Stage 1.** ✅ `pilot create` compiles a working Pilot without hand-editing.
Verified against the local board (12 steps, 1 attempt) and two live sites.

**Stage 2.** ✅ `jobs.search("linkedin")`, `jobs.search("talent")` and
`jobs.search("linkedin", "talent")` all return real postings, merged and
deduped, with per-source outcomes. Verified.

**Stage 3.** A Pilot compiled against layout A returns all eight postings and
handles the query cases; switching to layout B produces `PILOT_BROKEN`;
`pilot repair` produces a new version passing the same cases with the SDK call
unchanged.

Always green: `npm run typecheck` and `npm test` — unit tests plus an end-to-end
run of a script Pilot against the local board, with no model and no external
network.

---

## 13. Risks

**Some boards cannot be explored at all.** Measured 2026-09-19 by running
Pilot's own browser against each:

| Target | Result |
| --- | --- |
| Indeed | **Blocked.** Serves `Blocked - Indeed.com`, no listings |
| SimplyHired, Glassdoor | **Blocked.** Cloudflare interstitial |
| ZipRecruiter, WeWorkRemotely | **Blocked.** Cloudflare interstitial |
| **LinkedIn** | Compiles. Guest fragment endpoint, no browser needed at runtime |
| **Talent.com** | Compiles. Server-rendered, 3 pages, deduped |
| Dice, Built In, Wellfound, The Muse, USAJOBS | Load; not yet compiled |

Indeed, SimplyHired and Glassdoor are all Recruit Holdings properties and block
identically — treat them as one unavailable target, not three.

**Rate limiting is the live risk for LinkedIn.** Keep pagination to 3 pages,
identify the client honestly, respect `Retry-After`, and avoid per-record detail
fetches — a search that fires one request per result is what gets a client
blocked. The compiler is instructed accordingly.

**Terms of service.** Public-listing extraction sits in a contested area. Read
only, low volume, honest user agent, no working around anti-bot measures.

**Compile cost.** Each compile is a browser session plus up to 30 model turns.
The validation gate is what keeps a bad script from reaching `pilots/`.

**Generated code is executed.** See §4. Not sandboxed; review before trusting.
