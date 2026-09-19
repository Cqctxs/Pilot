# Pilot — specification

Pilot compiles a website into a reusable data API.

Point it at a URL, tell it what data you want, and it produces a **Pilot**: a
declarative recipe that extracts that data, validated against the live site.
Running a Pilot afterwards is ordinary deterministic code — no model call, no
per-request AI cost, no nondeterminism.

The compiler is the product. Job boards are the first thing we point it at.

---

## 1. Scope

### Build order

The project is built in three stages, in this order. Each stage has to work
before the next one starts.

**Stage 1 — the compiler.** `pilot create <url>` observes any website and emits
a validated recipe for an arbitrary set of fields. Proven against sites that
expose JSON and sites that only render HTML. This stage is capability-agnostic:
`--fields title,price,url` against a shop is as valid a test as a job board.

**Stage 2 — job search at scale.** The `jobs.board@1` capability, and Pilots for
real job boards — Indeed and LinkedIn as the headline targets. The fan-out API
lands here: one call, many boards, merged and deduped.

**Stage 3 — controlled testing.** A local job board we own, used to test the
things live sites cannot test on demand: a true no-match, a changed layout, and
repair after a break.

### In scope

| Component | What it is |
| --- | --- |
| Compiler | Observe a site, generate a recipe, validate it against live data, retry on failure |
| Recipe format | Declarative, reviewable JSON. Two kinds: `http-json` and `browser` |
| Runtime | Deterministic interpreters for both recipe kinds. No model calls |
| Capability | A named schema plus its normalization rules. `jobs.board@1` is the first |
| SDK | In-process TypeScript API with variadic target selection |
| CLI | `create`, `list`, `enable`/`disable`, `search`, `repair`, `testboard` |
| Test board | A local job board with two layouts, for controlled break-and-repair |

### Not in scope

No web dashboard. No package registry or publish/install flow — a compiled Pilot
is a file in `pilots/`, and sharing one is a commit. No authentication or
credentialed sessions; every target is public. No HTTP server — the SDK and CLI
call the runtime in-process. No write operations: Pilots read data, they do not
submit applications.

---

## 2. Architecture

```text
  pilot create <url>                      pilot search / SDK
          │                                        │
          ▼                                        ▼
  ┌───────────────┐                        ┌───────────────┐
  │   COMPILER    │ ── writes a Pilot ──▶  │    RUNTIME    │
  │  (uses a LLM) │                        │ (never does)  │
  └───────┬───────┘                        └───────┬───────┘
          │                                        │
   observe → generate                       http-json | browser
   → validate → retry                        interpreter
```

The line between those two boxes is the design. A model runs **once**, at
compile time, and its output is data rather than code. Everything a user
actually waits on — searching — is deterministic.

```text
src/
  shared/      schema, recipe format, Pilot artifact, errors, env
  compiler/    observe → generate → validate → repair, and the one model client
  runtime/     deterministic interpreters
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
await jobs.search("indeed");                // just Indeed
await jobs.search("indeed", "linkedin");    // both, merged and deduped
await jobs.search("indeed", { keywords: "software intern" });
await jobs.search({ keywords: "software intern", location: "Boston" });
```

**Argument rule.** Positional string arguments name Pilots; an optional trailing
object is the query. Both are optional and they compose freely.

**Selection rule.** No names means every *enabled* Pilot. Naming a Pilot runs
exactly that one, **whether or not it is enabled** — an explicit request is the
caller's decision, and silently skipping a named target would be worse than
running a disabled one.

### Result shape

```ts
interface SearchResult {
  jobs: Job[];
  sources: Array<{
    pilotId: string;
    ok: boolean;
    count: number;
    durationMs: number;
    error?: PilotError;
  }>;
}
```

A fan-out returns per-source outcomes because partial failure is the normal
case: LinkedIn rate-limits while Indeed answers. One dead source must never fail
the whole search. Sources run concurrently.

### Normalization

Every result passes through the same pipeline regardless of source, because
sites disagree about what a search means:

1. Records missing a required field are dropped, not half-populated.
2. Employment type is read from the site when it says, inferred from the title
   when it does not, and marked `unknown` when there is no signal. `typeBasis`
   records which — a caller can tell a fact from a guess.
3. Keyword and location filters are applied **locally**, after extraction, even
   when the query was also sent to the site. A site that ignores `?q=` and one
   that honours it must produce comparable results.
4. Cross-listed postings are deduped on normalized title + company.

---

## 4. Recipe format

A recipe is what the compiler emits and the runtime consumes. It names no
website in its structure — anything site-specific lives in the values.

### `http-json`

Preferred whenever the site has an endpoint carrying the records. Faster,
cheaper, and far more stable than driving a browser.

```json
{
  "recipeFormatVersion": 1,
  "kind": "http-json",
  "request": { "urlTemplate": "https://example.com/api/jobs?q={keywords}&start={offset}" },
  "pagination": { "kind": "counter", "variable": "offset", "start": 0, "step": 10, "maxPages": 3 },
  "recordsPath": "data.results",
  "fields": {
    "title": { "sources": [{ "path": "title" }], "allowMissing": false },
    "location": {
      "sources": [{ "path": "location.name" }, { "path": "locations", "joinWith": "; " }],
      "allowMissing": true
    }
  },
  "exclude": [{ "path": "isListed", "equals": false }]
}
```

Multiple `sources` per field is deliberate: real sites scatter one logical value
across shapes, and a recipe that expresses the fallback survives more of the site
than one that cannot.

### `browser`

Used when no endpoint carries the records.

```json
{
  "recipeFormatVersion": 1,
  "kind": "browser",
  "request": { "urlTemplate": "https://example.com/jobs?q={keywords}", "waitFor": { "kind": "css", "selector": ".job-card" } },
  "rows": { "kind": "css", "selector": ".job-card" },
  "fields": {
    "title": { "locator": { "kind": "css", "selector": "h2 a" }, "source": "text", "allowMissing": false },
    "url": { "locator": { "kind": "css", "selector": "h2 a" }, "source": "href", "allowMissing": false }
  },
  "emptyState": { "kind": "text", "text": "No results" }
}
```

`emptyState` separates "this site has zero results" from "this recipe is
broken". Without it, every empty page looks like a failure.

### Constraints

Both kinds are parsed by strict schemas. Unknown properties are rejected rather
than ignored. JSON paths are validated segment by segment and prototype keys
(`__proto__`, `constructor`, `prototype`) are refused. URLs must be `http(s)`.
A recipe must extract **exactly** the schema's fields — no omissions, no
inventions — checked before anything touches the network.

---

## 5. The compiler

```text
observe → generate → validate → (retry with the failure) → save
```

### Observe

Load the target in a real browser and record two things: the JSON responses the
page fetched (those that actually carry a list of records), and the rendered
DOM. Samples are trimmed — first few records per array, strings capped — so the
prompt stays bounded on a page with thousands of postings.

The model never sees the live site and never drives a browser. It sees the
observation object, once. That boundary is what makes a compile reproducible
and cheap.

### Generate

One model call producing a JSON recipe. The model is told the target schema and
shown the observation. Output is parsed and schema-checked before use.

### Validate

**This is the gate that makes it a compiler rather than a code generator.** A
candidate recipe is executed against the live site and rejected unless:

- it extracts at least one record;
- every required field is present on ≥90% of records;
- `url`-typed fields parse as URLs;
- the records are not all identical — which means the row locator matched a
  container instead of the repeating element.

### Retry

Failures are fed back verbatim as the next user turn: the rejected recipe plus
exactly what went wrong. Three attempts by default. Shape errors are caught
before any network round trip, so a malformed recipe costs nothing but a model
call.

A Pilot is only written after a recipe passes validation. There is no path that
produces an unvalidated Pilot.

### Repair

`pilot repair <id>` handles a site that changed under a working Pilot. It first
**reproduces the failure** — a Pilot that still works is left alone, since
replacing a known-good recipe with an unproven one is a regression. Then it
re-observes, and generates with the previous recipe and the observed failure as
context. Same validation gate. Minor version bump, with `repairedFrom` recorded.

---

## 6. Pilot artifacts

`pilots/<id>/<version>/pilot.json`, alongside a `sample.json` of the records
that validated it. No registry service, no database: loading is a directory
scan, publishing is a commit, and inspecting a Pilot is `cat`.

```json
{
  "pilotFormatVersion": 1,
  "id": "indeed",
  "version": "1.0.0",
  "target": { "name": "Indeed", "url": "https://www.indeed.com/jobs" },
  "capability": "jobs.board@1",
  "schema": { "...": "copied in, so a Pilot is self-describing" },
  "recipe": { "...": "" },
  "origin": "ai-generated",
  "compiler": { "model": "...", "attempts": 2, "repairedFrom": null },
  "evidence": { "recordCount": 42, "checkedAt": "...", "sampleFile": "sample.json" }
}
```

The latest version of each Pilot is what loads. A malformed Pilot warns and is
skipped — it must not take down every other Pilot.

`config/pilots.json` holds which Pilots are enabled and any bound variables
(e.g. a board's tenant slug). Configuration is separate from artifacts so that
enabling a Pilot never rewrites a compiled one.

---

## 7. CLI

```text
pilot create <url> [--id x] [--name x] [--capability jobs.board@1 | --fields a,b,c]
                   [--query text] [--attempts n]
pilot list [--json]
pilot enable <id> | pilot disable <id>
pilot search [targets...] [--keywords x] [--location x] [--type x] [--limit n] [--json]
pilot repair <id> [--failure text]
pilot testboard [--port n] [--layout a|b]
```

`pilot search` mirrors the SDK exactly: positional arguments are Pilot names,
flags are the query. Progress goes to stderr, results to stdout, so `--json`
output stays pipeable. Exit is non-zero only when *every* source failed.

---

## 8. Errors

Typed codes, because callers branch on them. The distinction that matters most
is between a site being temporarily unavailable and a Pilot being **wrong**:

| Code | Meaning |
| --- | --- |
| `SOURCE_UNAVAILABLE` / `RATE_LIMITED` / `BLOCKED` | Transient. Retry later; the Pilot is fine |
| `PILOT_BROKEN` | The recipe no longer matches the site. `pilot repair` is the fix |
| `INVALID_SOURCE_RESPONSE` | The site answered with something unparseable |
| `UNKNOWN_PILOT` / `NO_PILOTS_ENABLED` / `INVALID_ARGUMENT` | Caller error |
| `AI_NOT_CONFIGURED` / `AI_REQUEST_FAILED` / `VALIDATION_FAILED` | Compile-time only |

Conflating the first two rows would mean either repairing Pilots that are fine
or leaving broken ones in place.

---

## 9. Test board

`pilot testboard` serves a local job board on port 4100. It exists to test what
live sites cannot be asked to do on demand.

- Both transports: `/api/jobs` returns JSON, `/jobs` renders HTML. A working
  compiler should prefer the JSON.
- Two layouts. `--layout a` is a card list; `--layout b` is a table with
  different class names and nesting. A Pilot compiled against one **fails**
  against the other — the controlled break for `pilot repair`.
- Eight postings chosen to include the shapes that break naive extractors: a
  missing location, a job whose type appears only in its title, and two
  postings differing only by location.

---

## 10. Completion gates

**Stage 1.** `pilot create` compiles a working Pilot for a JSON-backed site and
for a DOM-only site, without hand-editing the result. `--fields` works for a
non-job schema — the compiler is not job-specific.

**Stage 2.** `jobs.search("indeed")`, `jobs.search("linkedin")`, and
`jobs.search("indeed", "linkedin")` all return real postings. The merged result
is deduped, and one source failing still returns the other's results.

**Stage 3.** A Pilot compiled against test board layout A returns all eight
postings; the query cases (keywords, location, type, true no-match) behave;
switching to layout B produces `PILOT_BROKEN`; `pilot repair` produces a new
version that passes the same cases unchanged. The SDK call is byte-identical
before and after the repair.

Always green: `npm run typecheck` and `npm test` — unit tests plus an end-to-end
run of the runtime against the local board, with no model and no external
network.

---

## 11. Risks

**Some boards cannot be observed at all.** A target is only viable if
`observe()` can load it in a real browser. Measured 2026-09-19, by running
Pilot's own observer against each:

| Target | Result |
| --- | --- |
| Indeed | **Blocked.** Serves `Blocked - Indeed.com`, ~400 chars, no listings |
| SimplyHired, Glassdoor | **Blocked.** Cloudflare interstitial |
| ZipRecruiter, WeWorkRemotely | **Blocked.** Cloudflare interstitial |
| LinkedIn | Loads. Guest job search renders listings without login |
| Talent.com, Dice, Built In, Wellfound | Load. Listings render |
| The Muse, USAJOBS | Load, and call their own JSON endpoints |

Indeed, SimplyHired and Glassdoor are all Recruit Holdings properties and all
block identically — treat them as one unavailable target, not three.

This is a property of the targets, not of the design. Where a board does load,
keep `maxPages` small, identify the client honestly, and respect `Retry-After`.
Boards hosted on Greenhouse, Lever and Ashby remain a strong fallback: they load
freely and cover a large share of real postings, though each hosted board is one
employer, so breadth there needs one Pilot per employer or a multi-instance
extension to `config/pilots.json`.

The architecture does not change with any of this; only which Pilots exist.

**Terms of service.** Public-listing extraction sits in a contested area. Keep
request volume low, identify the client honestly in the user agent, respect
`Retry-After`, and do not build around anti-bot measures. Read only; never
submit.

**Compile cost and flakiness.** Each compile is up to three model calls plus
live fetches. Observation samples are trimmed to bound prompt size; the
validation gate is what keeps a bad recipe from reaching `pilots/`.

**Browser recipes are inherently more brittle** than JSON ones. That is the
reason `pilot repair` exists, and the reason the compiler prefers `http-json`
whenever a usable endpoint is observed.
