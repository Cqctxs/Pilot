# Pilot token-savings benchmark

This benchmark asks Codex to build the same tiny job-search CLI twice:

1. **Without Pilot:** only the local job-board URL and acceptance test exist.
   Codex must discover and implement the integration.
2. **Warm Pilot:** the AI-generated `testboard` Pilot is already installed and
   normal `pilot init` guidance and generated `PILOT.md` are present. Codex can program against
   `jobs.search@1` instead of learning the website.

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
