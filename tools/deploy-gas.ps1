[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('test', 'template')]
  [string]$Target,

  [switch]$PromoteTemplate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedClasp {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  & clasp @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "clasp command failed: clasp $($Arguments -join ' ')"
  }
}

function Get-ProjectConfig {
  param([Parameter(Mandatory = $true)][string]$ConfigPath)

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Target configuration not found: $ConfigPath. Copy .clasp.example.json to this ignored file and set only its scriptId."
  }

  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($config.scriptId) -or $config.scriptId -eq 'REPLACE_WITH_YOUR_SCRIPT_ID') {
    throw "scriptId is missing in $ConfigPath."
  }
  if ($config.rootDir -ne './src') {
    throw "rootDir in $ConfigPath must be './src'."
  }
  return $config
}

function Assert-ReleaseTree {
  $branch = (& git branch --show-current).Trim()
  if ($branch -ne 'main') {
    throw "Deployment is blocked outside main. Current branch: $branch"
  }

  $changes = & git status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($changes)) {
    throw 'Deployment is blocked because the worktree is not clean.'
  }

  $head = (& git rev-parse HEAD).Trim()
  $originMain = (& git rev-parse origin/main).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -ne $originMain) {
    throw 'Deployment is blocked because HEAD does not match origin/main. Pull main first.'
  }
}

function Get-DeploymentRecords {
  param([Parameter(Mandatory = $true)][string]$ProjectConfig)

  $listing = & clasp --project $ProjectConfig deployments --json 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read existing deployments. No source was pushed.'
  }
  try {
    return @(($listing -join [Environment]::NewLine) | ConvertFrom-Json)
  } catch {
    throw 'Unable to parse existing deployments. No source was pushed.'
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectConfig = Join-Path $repositoryRoot ".clasp.$Target.local.json"
$otherTarget = if ($Target -eq 'test') { 'template' } else { 'test' }
$otherProjectConfig = Join-Path $repositoryRoot ".clasp.$otherTarget.local.json"
$project = Get-ProjectConfig -ConfigPath $projectConfig
$otherProject = Get-ProjectConfig -ConfigPath $otherProjectConfig

if ($Target -eq 'template' -and -not $PromoteTemplate) {
  throw 'Template deployment is blocked. Run this only after the user has confirmed the test deployment, with -PromoteTemplate.'
}
if ($project.scriptId -eq $otherProject.scriptId) {
  throw 'Test and template target Script IDs must differ.'
}

Push-Location -LiteralPath $repositoryRoot
try {
  $shortId = $project.scriptId.Substring(0, [Math]::Min(6, $project.scriptId.Length)) + '...'
  Write-Output "Target: $Target ($shortId)"
  Assert-ReleaseTree

  if ($Target -eq 'template') {
    $templateDeployments = Get-DeploymentRecords -ProjectConfig $projectConfig
    if (@($templateDeployments | Where-Object { $_.PSObject.Properties.Name -contains 'versionNumber' }).Count -ne 0) {
      throw 'Template promotion is blocked because the template original has a versioned deployment. Keep the original deployment-free; deploy only copied sheets.'
    }
  }

  Invoke-CheckedClasp @('--project', $projectConfig, 'status')
  Invoke-CheckedClasp @('--project', $projectConfig, 'push')

  if ($Target -eq 'template') {
    $templateDeploymentsAfterPush = Get-DeploymentRecords -ProjectConfig $projectConfig
    if (@($templateDeploymentsAfterPush | Where-Object { $_.PSObject.Properties.Name -contains 'versionNumber' }).Count -ne 0) {
      throw 'Template deployment verification failed: a versioned deployment exists on the original.'
    }
  } else {
    Get-DeploymentRecords -ProjectConfig $projectConfig | Out-Null
  }
} finally {
  Pop-Location
}
