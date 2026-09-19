# Pilot

> **Pilot gives every piece of software an API, whether its creator built one or not.**

Point Pilot at a website, tell it what data you want, and it compiles a
**Pilot** — a validated, declarative recipe for extracting that data. Running
that Pilot afterwards is ordinary deterministic code: no model call, no
per-request AI cost, no nondeterminism.

```ts
const jobs = pilot().capability("jobs.board@1");

await jobs.search();                        // every enabled board
await jobs.search("indeed");                // just Indeed
await jobs.search("indeed", "linkedin");    // both, merged and deduped
await jobs.search({ keywords: "software intern", location: "Boston" });
```

The application asks for *jobs*. It never learns what shape Indeed's HTML is in.

---

## Why

Hardware became broadly programmable because developers stopped writing code for
individual devices and started programming against common interfaces backed by
drivers. Software never got that layer.

Today, integrating with a job board, a student portal, an airline, or a
company's internal ERP means building and maintaining a separate integration for
each one — and if the system has no API, you are left with brittle browser
automation or nothing at all.

**Pilot is the missing driver layer.** Developers write against a capability;
individual Pilots implement that capability for specific software:

```text
jobs.board@1
├── indeed
├── linkedin
└── testboard
```

Write once, run against any software.

### Why not just point an agent at the page?

A browser agent re-solves the same page on every request — slow, expensive,
and differently wrong each time. Pilot uses a model **once**, at compile time,
and its output is data, not a live loop. What you run a thousand times is a
recipe you can read, diff, and version. When the site changes, the recipe fails
loudly instead of quietly returning something plausible.

---

## Status

Early. The build order is deliberate — see [SPEC.md](SPEC.md).

| Stage | What | State |
| --- | --- | --- |
| 1 | The compiler: any site, any fields | Pipeline wired; the `generate` step needs a real model key to exercise |
| 2 | Indeed + LinkedIn, fan-out search | Not started |
| 3 | Controlled testing on a local board | Board and runtime tests green |

The runtime, capability layer, SDK, CLI, and test board work end to end today
against a compiled Pilot. What is unproven is the compiler's output quality on
hostile real-world targets.

---

## Quick start

Requires **Node.js 24**.

```bash
npm install
npx playwright install chromium
cp .env.example .env     # add OPENAI_API_KEY + PILOT_COMPILER_MODEL to compile
```

Compiling needs a model key. **Running an already-compiled Pilot never does.**

### Try it against the local board

```bash
npm run testboard                     # serves http://127.0.0.1:4100

# in another terminal
npm run pilot -- create http://127.0.0.1:4100 --id testboard --name "Test Board"
npm run pilot -- search testboard --keywords intern
```

### Commands

```text
pilot create <url>            Compile a Pilot from a live site
  --fields title,price,url    Extract arbitrary fields instead of a capability
  --query <text>              Sample query used while validating
pilot list                    Installed Pilots and whether they are enabled
pilot enable|disable <id>     Include or exclude from unqualified searches
pilot search [targets...]     Search across Pilots (--keywords --location --type --limit --json)
pilot repair <id>             Recompile a Pilot whose site changed
pilot testboard               Serve the local job board (--layout a|b)
```

`pilot search` mirrors the SDK: positional arguments name Pilots, flags are the
query, and no names means every enabled Pilot.

---

## How it works

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

**Observe.** Load the site in a browser and record both the JSON it fetches and
the DOM it renders. The model sees this snapshot once — never the live site.

**Generate.** One call produces a declarative recipe: a URL template, a path to
the record array, and a path or locator per field.

**Validate.** The recipe is run against the live site and rejected unless it
pulls real records with the required fields present. Failures are fed back and
retried. **A Pilot is only written after its recipe passes.** That gate is the
difference between a compiler and a code generator.

**Run.** `http-json` recipes are plain fetches; `browser` recipes drive
Playwright. Both are deterministic interpreters — `capability/`, `runtime/`, and
`sdk/` cannot import `compiler/`, so searching can't reach a model by accident.

**Repair.** When a site changes, `pilot repair` reproduces the failure first (a
Pilot that still works is left alone), re-observes, and compiles a replacement
through the same gate. The calling code does not change.

---

## Layout

```text
src/
  shared/      schema, recipe format, Pilot artifact, errors, env
  compiler/    observe → generate → validate → repair
  runtime/     deterministic interpreters
  capability/  jobs.board@1: schema, normalization, filtering, dedupe
  pilots/      directory-backed Pilot store
  sdk/         the developer-facing API
  cli/         thin wrapper over the SDK
  testboard/   local job board for controlled tests
pilots/        compiled Pilots — plain files, committed
config/        which Pilots are enabled
```

`npm run typecheck` · `npm test` — unit tests plus an end-to-end run of the
runtime against the local board, with no model and no external network.

---

## A note on targets

Indeed and LinkedIn actively resist automated access, and public-listing
extraction sits in a contested area of their terms. Pilot reads only, keeps
request volume low, identifies itself honestly, and respects `Retry-After`. If a
headline target proves unworkable, boards built on Greenhouse, Lever, and Ashby
cover a large share of real postings and exercise the same compiler and the same
API. See [SPEC.md](SPEC.md) § 11.
