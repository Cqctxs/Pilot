[CmdletBinding()]
param(
  [string]$Model = "gpt-5.6-sol",
  [string]$Reasoning = "low",
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot ".pilot-live-demo"))
$expectedParent = [IO.Path]::GetFullPath($repoRoot).TrimEnd('\')

# This script resets its own generated workspaces. Resolve and validate the
# exact target before any recursive delete so a malformed path cannot broaden
# the operation to the repository or a parent directory.
if ([IO.Path]::GetDirectoryName($outputRoot).TrimEnd('\') -ne $expectedParent -or
    [IO.Path]::GetFileName($outputRoot) -ne ".pilot-live-demo") {
  throw "Refusing to reset unexpected demo directory: $outputRoot"
}

$worker = Join-Path $PSScriptRoot "demo-worker.ps1"
$promptFile = Join-Path $PSScriptRoot "live-prompt.txt"
$baseline = Join-Path $outputRoot "baseline"
$pilot = Join-Path $outputRoot "pilot"

function Format-Duration([int64]$Milliseconds) {
  if ($Milliseconds -lt 1000) { return "${Milliseconds}ms" }
  return ('{0:N1}s' -f ($Milliseconds / 1000.0))
}

Write-Host "Pilot visible token demo" -ForegroundColor Cyan
Write-Host "  Baseline: $baseline"
Write-Host "  Pilot:    $pilot"
Write-Host "  Prompt:   $promptFile"
Write-Host "  Model:    $Model ($Reasoning reasoning)"
Write-Host ""
Write-Host "Both windows receive the same prompt. The baseline ignores all user MCP"
Write-Host "configuration; only the warm window receives the explicit Pilot MCP."
Write-Host "The warm project installs LinkedIn, ZipRecruiter, and Talent from the registry."

if ($WhatIf) {
  Write-Host ""
  Write-Host "WhatIf: no folders, terminals, Codex sessions, or network calls were started."
  exit 0
}

Write-Host ""
Write-Host "> npm run build" -ForegroundColor DarkGray
Push-Location $repoRoot
try {
  $buildTimer = [Diagnostics.Stopwatch]::StartNew()
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $buildOutput = @(& npm run build 2>&1)
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $buildTimer.Stop()
  if ($buildExit -ne 0) {
    $buildOutput | ForEach-Object { Write-Host $_ }
    throw "Build failed with code $buildExit"
  }
  Write-Host ("  OK  " + (Format-Duration $buildTimer.ElapsedMilliseconds)) -ForegroundColor Green
} finally {
  Pop-Location
}

if (Test-Path -LiteralPath $outputRoot) {
  Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $baseline -Force | Out-Null
New-Item -ItemType Directory -Path $pilot -Force | Out-Null

$shell = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $shell) { $shell = Get-Command powershell.exe }

function Start-DemoWindow([string]$Kind, [string]$Workspace) {
  $arguments = @(
    "-NoExit",
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $worker + '"'),
    "-Kind", $Kind,
    "-RepoRoot", ('"' + $repoRoot + '"'),
    "-Workspace", ('"' + $Workspace + '"'),
    "-Model", $Model,
    "-Reasoning", $Reasoning
  )
  Start-Process -FilePath $shell.Source -ArgumentList $arguments -WindowStyle Normal | Out-Null
}

Write-Host ""
Write-Host "Opening two visible Codex runs in parallel..." -ForegroundColor Cyan
Start-DemoWindow "baseline" $baseline
Start-DemoWindow "pilot" $pilot

$baselineResult = Join-Path $baseline "result.json"
$pilotResult = Join-Path $pilot "result.json"
$deadline = (Get-Date).AddMinutes(20)
while ((-not (Test-Path -LiteralPath $baselineResult) -or -not (Test-Path -LiteralPath $pilotResult)) -and
       (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
}
if (-not (Test-Path -LiteralPath $baselineResult) -or -not (Test-Path -LiteralPath $pilotResult)) {
  throw "Timed out waiting for both demo sessions. Their visible windows contain the error details."
}

$without = Get-Content -LiteralPath $baselineResult -Raw | ConvertFrom-Json
$with = Get-Content -LiteralPath $pilotResult -Raw | ConvertFrom-Json
$saved = [int64]$without.usage.totalTokens - [int64]$with.usage.totalTokens
$percent = if ($without.usage.totalTokens -gt 0) {
  100 * $saved / [double]$without.usage.totalTokens
} else { 0 }

Write-Host ""
Write-Host "=== COMPARISON ===" -ForegroundColor Cyan
Write-Host ("Without Pilot: {0:N0} tokens; Codex build {1}; setup {2}; acceptance {3}" -f `
  $without.usage.totalTokens, `
  (Format-Duration $without.timing.codexBuildMs), `
  (Format-Duration $without.timing.setupMs), `
  $(if ($without.acceptancePassed) { "passed" } else { "FAILED" }))
Write-Host ("Warm Pilot:    {0:N0} tokens; Codex build {1}; setup {2}; acceptance {3}" -f `
  $with.usage.totalTokens, `
  (Format-Duration $with.timing.codexBuildMs), `
  (Format-Duration $with.timing.setupMs), `
  $(if ($with.acceptancePassed) { "passed" } else { "FAILED" }))
Write-Host ("Saved:         {0:N0} tokens ({1:N1}%)" -f $saved, $percent) -ForegroundColor Green
Write-Host ("Build time:    {0} without Pilot vs {1} with Pilot" -f `
  (Format-Duration $without.timing.codexBuildMs), `
  (Format-Duration $with.timing.codexBuildMs)) -ForegroundColor Green
Write-Host ""
Write-Host "Raw evidence:"
Write-Host "  $($without.trace)"
Write-Host "  $($with.trace)"
Write-Host ""
Write-Host "The two result windows are now interactive shells in their project folders."
Write-Host "Run more searches there, then close the windows when the demo is finished."
