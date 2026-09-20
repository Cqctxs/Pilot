import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const BENCHMARK_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BENCHMARK_DIR, "../..");
const OUTPUT_ROOT = path.join(ROOT, ".pilot-benchmark");
const PROMPT = readFileSync(path.join(BENCHMARK_DIR, "prompt.txt"), "utf8").trim();
const args = parseArgs(process.argv.slice(2));
const runCount = positiveInteger(args.runs ?? process.env.PILOT_BENCHMARK_RUNS ?? "1", "--runs");
const model = String(args.model ?? process.env.PILOT_BENCHMARK_MODEL ?? "gpt-5.6-sol");
const reasoning = String(args.reasoning ?? process.env.PILOT_BENCHMARK_REASONING ?? "low");
const caseMode = String(args.case ?? process.env.PILOT_BENCHMARK_CASE ?? "both");
if (!["both", "baseline", "pilot"].includes(caseMode)) {
  throw new Error("--case must be one of: both, baseline, pilot");
}

if (args.help) {
  process.stdout.write(`Usage: npm run benchmark:tokens -- [options]\n\n` +
    `  --runs <n>       Repetitions per case (default: 1)\n` +
    `  --model <id>     Codex model (default: gpt-5.6-sol)\n` +
    `  --reasoning <n>  Reasoning effort (default: low)\n` +
    `  --case <name>     both, baseline, or pilot (default: both)\n` +
    `  --codex <path>   Codex executable (default: codex)\n`);
  process.exit(0);
}

const codexBin = String(args.codex ?? process.env.PILOT_CODEX_BIN ?? "codex");
const codexHome = String(
  args["codex-home"] ??
  process.env.CODEX_HOME ??
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".codex"),
);
const startedAt = new Date().toISOString();

await main();

async function main() {
  const previous = readPreviousMeasurements();
  if (caseMode === "both") resetOutputRoot();
  else mkdirSync(OUTPUT_ROOT, { recursive: true });
  const board = await startBoardIfNeeded();
  try {
    await waitForBoard();
    const measurements = previous;

    // Alternate the first case across repetitions to reduce order/cache bias.
    for (let index = 1; index <= runCount; index += 1) {
      const both = index % 2 === 1 ? ["baseline", "pilot"] : ["pilot", "baseline"];
      const order = caseMode === "both" ? both : [caseMode];
      for (const kind of order) {
        const workspace = prepareWorkspace(kind, index);
        process.stdout.write(`\n[${kind} ${index}/${runCount}] Codex is building the app...\n`);
        const measurement = await runCodex(kind, index, workspace);
        measurements.push(measurement);
        process.stdout.write(
          `[${kind}] ${formatNumber(totalTokens(measurement.usage))} tokens, ` +
          `${formatDuration(measurement.durationMs)}, acceptance ${measurement.acceptance.ok ? "passed" : "FAILED"}\n`,
        );
      }
    }

    const report = buildReport(measurements);
    writeFileSync(path.join(OUTPUT_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(OUTPUT_ROOT, "report.md"), renderMarkdown(report));
    process.stdout.write(renderConsole(report));

    if (!report.measurements.every((item) => item.acceptance.ok)) process.exitCode = 1;
  } finally {
    stopBoard(board);
  }
}

function readPreviousMeasurements() {
  if (caseMode === "both") return [];
  const file = path.join(OUTPUT_ROOT, "report.json");
  if (!existsSync(file)) return [];
  const previous = JSON.parse(readFileSync(file, "utf8"));
  // A single-case rerun replaces that side while retaining the other side's
  // evidence and raw trace for quick benchmark iteration.
  return (previous.measurements ?? []).filter((item) => item.kind !== caseMode);
}

function resetOutputRoot() {
  const resolved = path.resolve(OUTPUT_ROOT);
  if (path.dirname(resolved) !== ROOT || path.basename(resolved) !== ".pilot-benchmark") {
    throw new Error(`Refusing to reset unexpected benchmark path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
}

async function startBoardIfNeeded() {
  if (await boardIsReady()) {
    process.stdout.write("[testboard] reusing the service already listening on port 4100\n");
    return null;
  }
  const entry = path.join(ROOT, "dist/cli/main.js");
  if (!existsSync(entry)) throw new Error("dist/ is missing; run npm run build first");
  const child = spawn(process.execPath, [entry, "testboard"], {
    cwd: ROOT,
    env: { ...process.env, PILOT_TESTBOARD_PORT: "4100" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[testboard] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[testboard] ${chunk}`));
  return child;
}

async function waitForBoard() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await boardIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Test board did not become ready on http://127.0.0.1:4100");
}

async function boardIsReady() {
  try {
    const response = await fetch("http://127.0.0.1:4100/api/jobs?q=software");
    if (!response.ok) return false;
    const body = await response.json();
    return Array.isArray(body.results) && body.results.some((job) => job.title === "Software Engineering Intern");
  } catch {
    return false;
  }
}

function stopBoard(child) {
  if (!child) return;
  if (!child.killed) child.kill();
}

function prepareWorkspace(kind, index) {
  const workspace = path.join(OUTPUT_ROOT, `run-${String(index).padStart(2, "0")}`, kind);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(path.join(workspace, "test"), { recursive: true });
  cpSync(path.join(BENCHMARK_DIR, "acceptance.mjs"), path.join(workspace, "test/acceptance.mjs"));
  writeFileSync(path.join(workspace, "TASK.md"), `${PROMPT}\n`);

  const packageJson = {
    name: `pilot-token-benchmark-${kind}-${index}`,
    private: true,
    type: "module",
    scripts: { test: "node test/acceptance.mjs" },
    ...(kind === "pilot" ? { dependencies: { "@pilot/sdk": `file:${ROOT.replaceAll("\\", "/")}` } } : {}),
  };
  writeFileSync(path.join(workspace, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  if (kind === "pilot") preparePilot(workspace);
  return workspace;
}

function preparePilot(workspace) {
  runChecked("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], workspace);
  cpSync(
    path.join(ROOT, "pilots/testboard/1.0.0"),
    path.join(workspace, "pilots/testboard/1.0.0"),
    { recursive: true },
  );
  mkdirSync(path.join(workspace, "config/capabilities"), { recursive: true });
  cpSync(
    path.join(ROOT, "config/capabilities/jobs.search@1.json"),
    path.join(workspace, "config/capabilities/jobs.search@1.json"),
  );
  writeFileSync(
    path.join(workspace, "config/pilots.json"),
    `${JSON.stringify({ pilots: [{ id: "testboard", enabled: true, variables: {} }] }, null, 2)}\n`,
  );

  // Generate the same agent instructions a real consumer gets from `pilot init`.
  runChecked(process.execPath, [path.join(workspace, "node_modules/@pilot/sdk/dist/cli/main.js"), "init"], workspace);
}

function runChecked(command, commandArgs, cwd) {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const executable = command === "npm" && existsSync(npmCli) ? process.execPath : command;
  const executableArgs = command === "npm" && existsSync(npmCli) ? [npmCli, ...commandArgs] : commandArgs;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${executableArgs.join(" ")} failed in ${cwd}\n` +
      `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

async function runCodex(kind, index, workspace) {
  const traceFile = path.join(workspace, "codex.jsonl");
  const stderrFile = path.join(workspace, "codex.stderr.log");
  const finalFile = path.join(workspace, "codex-final.txt");
  const invocation = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--approve-for-me",
    "--skip-git-repo-check",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    ...(kind === "pilot" ? pilotMcpConfig(workspace) : []),
    "--output-last-message",
    finalFile,
    PROMPT,
  ];

  const before = Date.now();
  const result = await captureProcess(codexBin, invocation, workspace, traceFile, stderrFile);
  const durationMs = Date.now() - before;
  const events = parseJsonl(traceFile);
  const usage = sumUsage(events);
  const acceptance = runAcceptance(workspace);
  const implementation = path.join(workspace, "src/search.mjs");

  return {
    kind,
    run: index,
    model,
    reasoning,
    durationMs,
    exitCode: result.exitCode,
    usage,
    actions: countActions(events),
    acceptance,
    implementation: existsSync(implementation)
      ? { bytes: readFileSync(implementation).byteLength, lines: readFileSync(implementation, "utf8").split(/\r?\n/).length }
      : null,
    files: {
      workspace: path.relative(ROOT, workspace),
      trace: path.relative(ROOT, traceFile),
      stderr: path.relative(ROOT, stderrFile),
      final: path.relative(ROOT, finalFile),
    },
  };
}

function pilotMcpConfig(workspace) {
  const entry = path.join(workspace, "node_modules/@pilot/sdk/dist/cli/main.js");
  return [
    "-c",
    `mcp_servers.pilot.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.pilot.args=${JSON.stringify([entry, "mcp"])}`,
    "-c",
    `mcp_servers.pilot.cwd=${JSON.stringify(workspace)}`,
    "-c",
    "mcp_servers.pilot.required=true",
  ];
}

function captureProcess(command, commandArgs, cwd, stdoutFile, stderrFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, PILOT_COMPILER_MODEL: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      writeFileSync(stdoutFile, stdout);
      writeFileSync(stderrFile, stderr);
      resolve({ exitCode });
    });
  });
}

function parseJsonl(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { type: "unparsed", line }; }
    });
}

function sumUsage(events) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  for (const event of events) {
    if (event.type !== "turn.completed" || !event.usage) continue;
    usage.inputTokens += Number(event.usage.input_tokens ?? 0);
    usage.cachedInputTokens += Number(event.usage.cached_input_tokens ?? 0);
    usage.outputTokens += Number(event.usage.output_tokens ?? 0);
    usage.reasoningOutputTokens += Number(event.usage.reasoning_output_tokens ?? 0);
  }
  return usage;
}

function countActions(events) {
  const completed = events.filter((event) => event.type === "item.completed").map((event) => event.item ?? {});
  return {
    commands: completed.filter((item) => item.type === "command_execution").length,
    mcpCalls: completed.filter((item) => item.type === "mcp_tool_call").length,
    webSearches: completed.filter((item) => item.type === "web_search").length,
  };
}

function runAcceptance(workspace) {
  const result = spawnSync(process.execPath, ["test/acceptance.mjs"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
    env: { ...process.env, OPENAI_API_KEY: "", PILOT_COMPILER_MODEL: "" },
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function buildReport(measurements) {
  const baseline = measurements.filter((item) => item.kind === "baseline");
  const pilot = measurements.filter((item) => item.kind === "pilot");
  const baselineMedian = median(baseline.map((item) => totalTokens(item.usage)));
  const pilotMedian = median(pilot.map((item) => totalTokens(item.usage)));
  const saved = baselineMedian - pilotMedian;
  return {
    benchmarkVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    model,
    reasoning,
    runsPerCase: runCount,
    definition: "Codex tokens used to build the same tested app; the Pilot case starts with an already-compiled driver.",
    measurements,
    summary: {
      baselineMedianTokens: baselineMedian,
      pilotMedianTokens: pilotMedian,
      medianTokensSaved: saved,
      medianPercentSaved: baselineMedian === 0 ? 0 : (saved / baselineMedian) * 100,
      baselineMedianDurationMs: median(baseline.map((item) => item.durationMs)),
      pilotMedianDurationMs: median(pilot.map((item) => item.durationMs)),
    },
  };
}

function renderConsole(report) {
  const summary = report.summary;
  return `\nToken benchmark complete\n` +
    `  Without Pilot: ${formatNumber(summary.baselineMedianTokens)} median tokens\n` +
    `  Warm Pilot:    ${formatNumber(summary.pilotMedianTokens)} median tokens\n` +
    `  Saved:         ${formatNumber(summary.medianTokensSaved)} tokens (${summary.medianPercentSaved.toFixed(1)}%)\n` +
    `  Report:        ${path.relative(ROOT, path.join(OUTPUT_ROOT, "report.md"))}\n` +
    `  Raw traces:    ${path.relative(ROOT, OUTPUT_ROOT)}\n`;
}

function renderMarkdown(report) {
  const s = report.summary;
  const lines = [
    "# Pilot token-savings benchmark",
    "",
    report.definition,
    "",
    `Model: \`${report.model}\` · reasoning: \`${report.reasoning}\` · runs per case: ${report.runsPerCase}`,
    "",
    `- Without Pilot: **${formatNumber(s.baselineMedianTokens)}** median tokens`,
    `- Warm Pilot: **${formatNumber(s.pilotMedianTokens)}** median tokens`,
    `- Saved: **${formatNumber(s.medianTokensSaved)} tokens (${s.medianPercentSaved.toFixed(1)}%)**`,
    `- Without Pilot duration: ${formatDuration(s.baselineMedianDurationMs)}`,
    `- Warm Pilot duration: ${formatDuration(s.pilotMedianDurationMs)}`,
    "",
    "`inputTokens` already includes cached input; cached tokens are reported separately and are not added twice.",
    "This benchmark measures the outer coding agent building the app. Runtime calls through an installed Pilot make zero compiler-model calls.",
    "",
    "## Runs",
    "",
  ];
  for (const item of report.measurements) {
    lines.push(
      `- ${item.kind} #${item.run}: ${formatNumber(totalTokens(item.usage))} tokens, ` +
      `${formatDuration(item.durationMs)}, acceptance ${item.acceptance.ok ? "passed" : "failed"}`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function totalTokens(usage) {
  // cachedInputTokens is a subset of inputTokens, not an additional bucket.
  return usage.inputTokens + usage.outputTokens;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") out.help = true;
    else if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      out[key] = next;
      index += 1;
    } else if (/^\d+$/.test(value) && out.runs === undefined) {
      // npm 11 on PowerShell may consume `--runs` and forward only its value.
      out.runs = value;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}
