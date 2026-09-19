# Pilot

> **Pilot gives every piece of software an API, whether its creator built one or not.**

Point Pilot at a website. A model explores it with a real browser, tests
extraction until it works, and writes a script. From then on that script runs on
its own — no model call, no per-request AI cost, no nondeterminism.

```ts
const jobs = pilot().capability("jobs.board@1");

await jobs.search();                        // every enabled board
await jobs.search("linkedin");              // just LinkedIn
await jobs.search("linkedin", "talent");    // both, merged and deduped
await jobs.search({ keywords: "software intern", location: "Boston" });
await jobs.search("linkedin", { type: "full-time" });
await jobs.search("talent", { filters: { seniority: "Senior" } });
```

The application asks for *jobs*. It never learns what shape LinkedIn's HTML is in.

Other function types use the same mechanism with their own shared schema:

```ts
const hotels = pilot().capability("hotels.search@1");
await hotels.search("booking", {
  params: { destination: "Toronto", checkIn: "2026-10-10" },
  filters: { stars: 5 },
});
```

---

## Why

Hardware became broadly programmable because developers stopped writing code for
individual devices and started programming against common interfaces backed by
drivers. Software never got that layer.

Integrating with a job board, a student portal, an airline, or an internal ERP
means building and maintaining a separate integration for each — and if the
system has no API, you are left with brittle browser automation or nothing.

**Pilot is the missing driver layer.** Developers write against a capability;
individual Pilots implement it for specific software:

```text
jobs.board@1
├── linkedin      (no browser — found the guest endpoint)
├── talent        (browser — server-rendered, 3 pages)
└── testboard
```

### Why not just point an agent at the page?

A browser agent re-solves the same page on every request — slow, expensive, and
differently wrong each time. Pilot uses a model **once**, to write a script. What
you run a thousand times is code you can read, diff, and version. When the site
changes, it fails loudly instead of quietly returning something plausible.

---

## Status

| Stage | What | State |
| --- | --- | --- |
| 1 | The compiler: any site, any fields | **Working** |
| 2 | LinkedIn + Talent.com, fan-out search | **Working** |
| 3 | Controlled break-and-repair on a local board | Board + runtime tests green; repair untested end to end |

Compiled so far, all first attempt:

| Pilot | Steps | Records | Transport |
| --- | --- | --- | --- |
| `linkedin` | 17 | 30 | `fetch` — found the guest fragment endpoint |
| `talent` | 18 | 59 | browser — server-rendered, paginated, deduped |
| `testboard` | 12 | 4 | browser |

---

## Quick start

Requires **Node.js 24**.

```bash
npm install
node node_modules/playwright/cli.js install chromium
cp .env.example .env     # OPENAI_API_KEY + PILOT_COMPILER_MODEL
```

Compiling needs a model key. **Running a compiled Pilot never does.**

```bash
npm run testboard        # a local board on :4100

npm run pilot -- create http://127.0.0.1:4100/jobs --id testboard
npm run pilot -- search testboard --keywords intern
```

Against a real board:

```bash
npm run pilot -- create "https://www.talent.com/jobs?k=software+intern&l=Boston" \
  --id talent --query "software intern" --location Boston
npm run pilot -- search linkedin talent --keywords intern --type internship
```

### Commands

```text
pilot create <url>            Compile a Pilot from a live site
  --capability <id>           Shared function type, e.g. hotels.search@1
  --fields name,price,url     Seed a new capability, or extract ad-hoc fields
  --query / --location        Values the script is validated against
  --watch                     Show the browser while it explores
pilot list                    Installed Pilots and whether they are enabled
pilot capabilities            Shared schemas and their versions
pilot enable|disable <id>     Include or exclude from unqualified searches
pilot search [targets...]     --keywords --location --type --limit --filter --json
                              --capability <id> --param field=value,...
pilot repair <id>             Recompile a Pilot whose site changed
pilot testboard               Serve the local board (--layout a|b)

pilot publish <id>            Push a compiled Pilot to the registry
pilot install <id>[@version]  Install one from the registry
pilot registry list           Every published Pilot
pilot registry search <text>  Find one by site, capability, or field
pilot registry health [id]    Success rate per Pilot, worst first

pilot mcp                     Serve Pilot over MCP to Claude Code / Codex
```

For a brand-new capability, `--fields` is optional. If omitted, the compiler
must propose and validate the initial shared schema before anything is saved.

---

## For agents (MCP)

A browsing agent re-solves a site on every request and the capability dies with
the session. Pilot makes it permanent: an agent that needs data from a site with
no API compiles a Pilot **once**, and from then on it — and every other agent on
the team — has a tool that costs no tokens to run.

```bash
pilot mcp     # stdio MCP server
```

Claude Code picks up the `.mcp.json` in this repo automatically. For Codex, in
`~/.codex/config.toml`:

```toml
[mcp_servers.pilot]
command = "npx"
args = ["tsx", "src/cli/main.ts", "mcp"]
cwd = "/path/to/Pilot"
```

Nine tools:

| Tool | What it does |
| --- | --- |
| `pilot_list` | What this machine can already do |
| `pilot_search` | Job boards, merged and deduped |
| `pilot_run` | Any Pilot, raw records — for non-jobs schemas |
| `pilot_create` | **Compile a new site into a Pilot** |
| `pilot_repair` | Recompile one whose site changed |
| `pilot_registry_search` | Has someone already compiled this? |
| `pilot_install` / `pilot_publish` | Move Pilots between machines |
| `pilot_health` | What is failing, worst first |

Measured end to end through a real MCP client, starting from an empty Pilot
directory:

```text
pilot_list    → No Pilots installed.
pilot_create  → Compiled mcpboard@1.0.0 (browser, 13 steps, 1 attempt), 25s
pilot_search  → 4 jobs from 1/1 source(s)
```

The agent built the tool and then used it, in one conversation.

`pilot_create` and `pilot_repair` take minutes and may exceed a client's default
tool timeout; they stream progress as MCP log notifications. Everything else is
ordinary compiled code and returns in seconds.

---

## The registry

Compiling a site is the expensive part, and nobody should pay it twice. The
registry is where a compiled Pilot goes so the next person can just install it.

```bash
# .env
PILOT_REGISTRY_URI=mongodb+srv://...
PILOT_PUBLISHER=your-name
```

```bash
pilot publish linkedin
pilot install linkedin            # on any other machine
pilot registry search salary      # which Pilots see a salary field?
```

An installed Pilot is byte-identical to a compiled one — same files, same
directory — so nothing downstream can tell them apart.

**MongoDB**, because a Pilot already *is* a document: its `schema` block differs
per capability, so there is no fixed table to flatten it into, and adding a
capability must not mean writing a migration. One document holds the artifact,
the script, and its provenance.

### Health is the interesting part

Every `pilot search` reports per-source outcomes back to the registry
(best-effort, `--no-report` to opt out). An aggregation turns that stream into a
rolling success rate:

```text
ID         VERSION  RUNS  OK%   AVG RECS  LAST ERROR
talent     1.0.0      41   46%       2.1  PILOT_BROKEN
linkedin   1.0.0      39  100%      29.6  —
```

Sorted worst first, so the top row is the next thing to recompile. This is how
Pilot finds out a site changed: from the searches people are already running,
rather than from someone noticing and filing a bug. The report keeps the last
*error* rather than the last run's error code — otherwise a Pilot that fails
half the time reads as healthy whenever its newest run happened to succeed.

---

## How it works

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

**Explore.** The model drives a real browser through a narrow tool surface:
`goto`, `find` (test a selector, see what matched), `fill`, `click` (returns the
resulting URL — how the search pattern gets discovered), `evaluate` (run a
candidate extraction *in the page* and look at the output), `requests` (JSON the
page fetched).

`evaluate` is the one that matters. It turns "guess a selector from a wall of
HTML" into "test it and see what came back".

**Validate.** The submitted script is run for real and rejected unless it returns
records with the required fields present. Rejections go back with the browser
still open, so the model investigates rather than restarting. **A Pilot is only
written after a real run succeeds** — that gate is the difference between a
compiler and a code generator.

The model may also propose useful optional fields that the listing exposes. Its
generated JavaScript owns the site-specific interpretation: a source label named
`role` can populate `employmentType` on one site and `title` on another. A new
field must have a valid name and type and produce a real value during validation
before it is copied into the Pilot's schema.

Every capability has a versioned shared schema in `config/capabilities/`.
Pilots compile against that base and store only their additional fields as
extensions. When two distinct Pilots implement a compatible extension, Pilot
promotes it into the next minor revision of the shared schema, so later
compilations receive it automatically.

**Run.** Load the module, call `search(page, query)`. Scripts that found an
endpoint skip Chromium entirely. `capability/`, `runtime/` and `sdk/` cannot
import `compiler/`, so searching can't reach a model by accident.

SDK results expose compiler-added fields through `job.attributes`, while
`SearchResult.fields` advertises the union supported by the selected Pilots.
They can be filtered locally with `filters` in the SDK or with
`--filter seniority=Senior,remoteMode=Remote` in the CLI.

**Repair.** `pilot repair` reproduces the failure first — a Pilot that still
works is left alone — then re-explores and recompiles through the same gate.

### Generated code is executed

A compiled script is code, and it runs with this process's privileges. It is not
sandboxed. The runtime enforces a timeout, a record cap, a shape check, and
static rejection of `require`/`import`/`process`/Node built-ins. A Pilot is a
readable file in `pilots/` — read it before trusting it, like any dependency.
See [SPEC.md](SPEC.md) §4.

---

## Layout

```text
src/
  shared/      schema, Pilot artifact, errors, env
  compiler/    explorer, model client, validate, the loop
  runtime/     loads and runs compiled scripts
  capability/  jobs.board@1: schema, normalization, filtering, dedupe
  pilots/      directory-backed Pilot store
  registry/    MongoDB-backed publish, install, search, health
  mcp/         MCP server — the same operations, for agents
  sdk/         the developer-facing API
  cli/         thin wrapper over the SDK
  testboard/   local job board for controlled tests
pilots/        compiled Pilots — plain files, committed
```

`npm run typecheck` · `npm test` — unit tests plus an end-to-end run of a script
Pilot against the local board, with no model and no external network.

---

## A note on targets

Indeed, SimplyHired, Glassdoor and ZipRecruiter all block automated access
outright — verified, not assumed. LinkedIn and Talent.com both work. Pilot reads
only, keeps volume low, identifies itself honestly, and does not work around
anti-bot measures. See [SPEC.md](SPEC.md) §13.
