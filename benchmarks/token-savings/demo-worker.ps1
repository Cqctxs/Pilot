[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("baseline", "pilot")]
  [string]$Kind,

  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [Parameter(Mandatory = $true)]
  [string]$Workspace,

  [string]$Model = "gpt-5.6-sol",
  [string]$Reasoning = "low"
)

$ErrorActionPreference = "Stop"
$label = if ($Kind -eq "pilot") { "WARM PILOT" } else { "BASELINE" }
$host.UI.RawUI.WindowTitle = "Pilot token demo - $label"

function Write-Heading([string]$Text) {
  Write-Host ""
  Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Format-Duration([int64]$Milliseconds) {
  if ($Milliseconds -lt 1000) { return "${Milliseconds}ms" }
  return ('{0:N1}s' -f ($Milliseconds / 1000.0))
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  Write-Host ("> " + $Command + " " + ($Arguments -join " ")) -ForegroundColor DarkGray
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = @(& $Command @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $timer.Stop()
  if ($exitCode -ne 0) {
    $output | ForEach-Object { Write-Host $_ }
    throw "$Command exited with code $exitCode after $(Format-Duration $timer.ElapsedMilliseconds)"
  }
  Write-Host ("  OK  " + (Format-Duration $timer.ElapsedMilliseconds)) -ForegroundColor Green
}

function Import-RegistryEnvironment {
  if ($env:PILOT_REGISTRY_URI) { return }
  $envFile = Join-Path $RepoRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw "No registry environment is configured. Expected $envFile or PILOT_REGISTRY_URI."
  }

  $loaded = @()
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -notmatch '^\s*(PILOT_REGISTRY_URI|PILOT_REGISTRY_DB|PILOT_PUBLISHER)\s*=\s*(.*)\s*$') {
      continue
    }
    $name = $matches[1]
    $value = $matches[2].Trim().Trim('"').Trim("'")
    if ($value) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
      $loaded += $name
    }
  }
  if (-not $env:PILOT_REGISTRY_URI) {
    throw "PILOT_REGISTRY_URI is empty. Configure it before running the live demo."
  }
  Write-Host ("Loaded registry settings without copying secrets: " + ($loaded -join ", "))
}

function Show-CodexEvent([object]$Event) {
  if ($Event.type -eq "thread.started") {
    Write-Host "Codex thread: $($Event.thread_id)" -ForegroundColor DarkGray
    return
  }
  if ($Event.type -eq "turn.completed") {
    $total = [int64]$Event.usage.input_tokens + [int64]$Event.usage.output_tokens
    Write-Host "TOKENS: $total (input $($Event.usage.input_tokens), output $($Event.usage.output_tokens), cached input $($Event.usage.cached_input_tokens))" -ForegroundColor Green
    return
  }
  if ($Event.type -ne "item.completed") { return }

  $item = $Event.item
  switch ($item.type) {
    "mcp_tool_call" {
      Write-Host "CODEX MCP > $($item.server).$($item.tool)  [$($item.status)]" -ForegroundColor Magenta
    }
    "command_execution" {
      Write-Host "CODEX > $($item.command)" -ForegroundColor Yellow
      Write-Host "  exit $($item.exit_code)"
      if ($item.exit_code -ne 0 -and $item.aggregated_output) {
        $output = [string]$item.aggregated_output
        if ($output.Length -gt 1000) { $output = $output.Substring($output.Length - 1000) }
        Write-Host $output
      }
    }
    "file_change" {
      $paths = @($item.changes | ForEach-Object { $_.path })
      Write-Host ("CODEX WROTE > " + ($paths -join ", ")) -ForegroundColor Blue
    }
  }
}

$startedAt = Get-Date
$resultFile = Join-Path $Workspace "result.json"
$traceFile = Join-Path $Workspace "codex.jsonl"
$stderrFile = Join-Path $Workspace "codex.stderr.log"
$finalFile = Join-Path $Workspace "codex-final.txt"
$acceptancePassed = $false
$codexExit = -1
$setupMs = 0
$codexMs = 0
$acceptanceMs = 0
$usage = [ordered]@{
  inputTokens = 0
  cachedInputTokens = 0
  outputTokens = 0
  totalTokens = 0
}

try {
  $setupTimer = [Diagnostics.Stopwatch]::StartNew()
  Write-Heading "$label PROJECT SETUP"
  Write-Host "Workspace: $Workspace"
  Write-Host "> New-Item src, test" -ForegroundColor DarkGray
  New-Item -ItemType Directory -Path (Join-Path $Workspace "src") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $Workspace "test") -Force | Out-Null
  Write-Host "> Copy-Item live-acceptance.mjs test/acceptance.mjs" -ForegroundColor DarkGray
  Copy-Item -LiteralPath (Join-Path $RepoRoot "benchmarks/token-savings/live-acceptance.mjs") `
    -Destination (Join-Path $Workspace "test/acceptance.mjs")

  Push-Location $Workspace
  Invoke-Checked "npm" @("init", "-y")
  Invoke-Checked "npm" @("pkg", "set", "type=module")
  Invoke-Checked "npm" @("pkg", "set", "scripts.test=node test/acceptance.mjs")

  if ($Kind -eq "pilot") {
    Write-Heading "INSTALL PILOT THROUGH NORMAL COMMANDS"
    Import-RegistryEnvironment
    Invoke-Checked "npm" @("install", $RepoRoot, "--ignore-scripts", "--no-audit", "--no-fund")
    foreach ($pilotId in @("linkedin", "ziprecruiter", "talent")) {
      Invoke-Checked "npx" @("--no-install", "pilot", "install", $pilotId)
    }
    Invoke-Checked "npx" @("--no-install", "pilot", "init")
  }
  $setupTimer.Stop()
  $setupMs = $setupTimer.ElapsedMilliseconds
  Write-Host ("PROJECT SETUP TIME: " + (Format-Duration $setupMs)) -ForegroundColor Cyan

  # Neither side may invoke Pilot's compiler. Codex authentication is separate
  # from OPENAI_API_KEY and continues to work through the signed-in CLI.
  $env:OPENAI_API_KEY = ""
  $env:PILOT_COMPILER_MODEL = ""

  $promptFile = Join-Path $RepoRoot "benchmarks/token-savings/live-prompt.txt"
  $prompt = (Get-Content -LiteralPath $promptFile -Raw).Trim()
  $promptHash = (Get-FileHash -LiteralPath $promptFile -Algorithm SHA256).Hash
  Write-Heading "IDENTICAL PROMPT"
  Write-Host $prompt -ForegroundColor White
  Write-Host ""
  Write-Host "Prompt: $promptFile"
  Write-Host "Prompt SHA256: $promptHash (identical in both windows)"

  $codexArgs = @(
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--approve-for-me",
    "--skip-git-repo-check",
    "--model", $Model,
    "-c", ('model_reasoning_effort="' + $Reasoning + '"')
  )

  if ($Kind -eq "pilot") {
    $node = (Get-Command node).Source
    $entry = Join-Path $Workspace "node_modules/@pilot/sdk/dist/cli/main.js"
    $nodeToml = $node.Replace("\", "\\").Replace('"', '\"')
    $entryToml = $entry.Replace("\", "\\").Replace('"', '\"')
    $cwdToml = $Workspace.Replace("\", "\\").Replace('"', '\"')
    $codexArgs += @(
      "-c", ('mcp_servers.pilot.command="' + $nodeToml + '"'),
      "-c", ('mcp_servers.pilot.args=["' + $entryToml + '","mcp"]'),
      "-c", ('mcp_servers.pilot.cwd="' + $cwdToml + '"'),
      "-c", "mcp_servers.pilot.required=true"
    )
  }

  $codexArgs += @("--output-last-message", $finalFile, $prompt)
  Write-Heading "VISIBLE CODEX SESSION"
  Write-Host ("> codex exec --json --ignore-user-config --ignore-rules --approve-for-me " +
    "--skip-git-repo-check --model $Model -c model_reasoning_effort=$Reasoning " +
    "--output-last-message $finalFile [prompt SHA256 $promptHash]") -ForegroundColor DarkGray
  if ($Kind -eq "pilot") {
    Write-Host "  MCP override: node $entry mcp (cwd $Workspace)"
  } else {
    Write-Host "  MCP override: none"
  }
  Write-Host "  raw events: $traceFile"

  if (Test-Path -LiteralPath $traceFile) { Remove-Item -LiteralPath $traceFile -Force }
  $codexTimer = [Diagnostics.Stopwatch]::StartNew()
  & codex @codexArgs 2> $stderrFile | ForEach-Object {
    $line = [string]$_
    Add-Content -LiteralPath $traceFile -Value $line -Encoding utf8
    try {
      $event = $line | ConvertFrom-Json
      Show-CodexEvent $event
      if ($event.type -eq "turn.completed") {
        $usage.inputTokens += [int64]$event.usage.input_tokens
        $usage.cachedInputTokens += [int64]$event.usage.cached_input_tokens
        $usage.outputTokens += [int64]$event.usage.output_tokens
      }
    } catch {
      Write-Host $line
    }
  }
  $codexExit = $LASTEXITCODE
  $codexTimer.Stop()
  $codexMs = $codexTimer.ElapsedMilliseconds
  $usage.totalTokens = $usage.inputTokens + $usage.outputTokens
  Write-Host ("CODEX BUILD TIME: " + (Format-Duration $codexMs)) -ForegroundColor Cyan

  Write-Heading "INDEPENDENT ACCEPTANCE TEST"
  Write-Host "> npm test" -ForegroundColor DarkGray
  $acceptanceTimer = [Diagnostics.Stopwatch]::StartNew()
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $acceptanceOutput = @(& npm test 2>&1)
  $acceptanceExit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $acceptanceTimer.Stop()
  $acceptanceMs = $acceptanceTimer.ElapsedMilliseconds
  $acceptancePassed = $acceptanceExit -eq 0
  if ($acceptancePassed) {
    Write-Host ("  PASS  " + (Format-Duration $acceptanceMs)) -ForegroundColor Green
  } else {
    $acceptanceOutput | ForEach-Object { Write-Host $_ }
  }
  if (-not $acceptancePassed) {
    Write-Warning "Acceptance failed. Live sites can block or change independently of the benchmark."
  }
} catch {
  Write-Host "DEMO ERROR: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  $result = [ordered]@{
    kind = $Kind
    model = $Model
    reasoning = $Reasoning
    durationMs = [int64]((Get-Date) - $startedAt).TotalMilliseconds
    timing = [ordered]@{
      setupMs = $setupMs
      codexBuildMs = $codexMs
      acceptanceMs = $acceptanceMs
    }
    codexExitCode = $codexExit
    acceptancePassed = $acceptancePassed
    usage = $usage
    workspace = $Workspace
    trace = $traceFile
    final = $finalFile
  }
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultFile -Encoding utf8

  Write-Heading "$label RESULT"
  Write-Host "Tokens: $($usage.totalTokens)" -ForegroundColor Green
  Write-Host ("Project setup: " + (Format-Duration $setupMs))
  Write-Host ("Codex build:   " + (Format-Duration $codexMs))
  Write-Host ("Verification:  " + (Format-Duration $acceptanceMs))
  Write-Host ("Total:         " + (Format-Duration $result.durationMs)) -ForegroundColor Cyan
  Write-Host "Acceptance: $(if ($acceptancePassed) { 'PASSED' } else { 'FAILED' })"
  Write-Host "Raw trace: $traceFile"
  Write-Host ""
  Set-Location $Workspace
  Write-Host "This is now an interactive shell in $Workspace" -ForegroundColor Cyan
  Write-Host "Try the generated application:" -ForegroundColor Cyan
  Write-Host '  node src/search.mjs --keywords "software engineer" --location Massachusetts --limit 2'
  Write-Host "  npm test"
  if ($Kind -eq "pilot") {
    Write-Host "Or call the installed Pilots directly:" -ForegroundColor Cyan
    Write-Host '  npx pilot search linkedin ziprecruiter talent --keywords "software engineer" --location Massachusetts --limit 2'
    Write-Host '  npx pilot search linkedin --keywords "machine learning" --location Toronto --limit 3'
  }
  Write-Host ""
  Write-Host "The terminal will stay open; close the window when the demo is finished."
}
