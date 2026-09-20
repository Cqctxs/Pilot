# Pilot token-savings benchmark

This benchmark asks Codex to build the same tiny job-search CLI twice:

1. **Without Pilot:** only the local job-board URL and acceptance test exist.
   Codex must discover and implement the integration.
2. **Warm Pilot:** the AI-generated `testboard` Pilot is already installed and
   exposed through the MCP server configured by `pilot init`. Codex can query
   the live `jobs.search@1` contract instead of learning the website.

Both cases receive the exact prompt in `prompt.txt` and must pass the exact
acceptance test in `acceptance.mjs`. The controlled board serves both HTML and a
JSON endpoint, so the baseline can make a reasonable direct integration without
depending on a public site's uptime or bot policy.

Codex's `--json` stream reports input, cached-input, output, and reasoning-output
tokens on `turn.completed`. The harness keeps the raw JSONL for inspection and
compares `input_tokens + output_tokens`; cached input is already included in
`input_tokens` and is not counted twice.

## Run it

From the Pilot repository root:

```powershell
npm run benchmark:tokens
```

For a less noisy demo number, use three alternating repetitions and report the
median:

```powershell
$env:PILOT_BENCHMARK_RUNS = "3"
npm run benchmark:tokens
Remove-Item Env:PILOT_BENCHMARK_RUNS
```

Optional overrides:

```powershell
$env:PILOT_BENCHMARK_MODEL = "gpt-5.6-sol"
$env:PILOT_BENCHMARK_REASONING = "low"
npm run benchmark:tokens
```

While iterating on one side, retain the other side's last trace and rerun only
the selected case:

```powershell
$env:PILOT_BENCHMARK_CASE = "pilot" # pilot | baseline | both
npm run benchmark:tokens
Remove-Item Env:PILOT_BENCHMARK_CASE
```

Outputs are written beneath `.pilot-benchmark/`:

- `report.md` — presentation-ready summary;
- `report.json` — machine-readable measurements;
- `run-*/baseline/codex.jsonl` and `run-*/pilot/codex.jsonl` — raw evidence;
- each generated `src/search.mjs`, final message, and stderr log.

This measures the tokens the outer coding agent needs to build the application.
It is separate from the one-time Responses API usage of `pilot create`. A warm
Pilot execution itself makes zero compiler-model calls; the coding agent still
uses some tokens to understand the task and write the small application.

## Visible two-window live demo

The judged demo can use LinkedIn, ZipRecruiter, and Talent instead of the local
testboard. It creates two projects with `npm init`, opens two visible PowerShell
windows, runs the same Codex prompt concurrently, executes the same acceptance
test, and compares the `turn.completed` token counts. The warm project installs
all three Pilots from the configured registry; it does not copy artifacts from
this repository.

The visible output is intentionally concise: every setup command and every
command Codex runs is shown, the complete identical prompt is printed in both
windows, and successful command bodies are hidden. Full Codex event output
remains in the raw trace. Each result separates project setup time, Codex
implementation time, acceptance-test time, and total elapsed time.

After both runs finish, their windows remain open as ordinary interactive
PowerShell sessions in the generated project folders. Both can rerun the app or
`npm test`; the warm window can also run `npx pilot search ...` directly to
show live jobs from the installed Pilots.

Preview the setup without changing anything:

```powershell
npm run demo -- -WhatIf
```

Run it:

```powershell
npm run demo
```

The live version is presentation evidence, not the controlled benchmark:
public sites can change markup or block one session independently. Its raw
Codex JSONL traces and result files are kept under `.pilot-live-demo/`.
