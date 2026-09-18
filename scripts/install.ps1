<#
.SYNOPSIS
	Builds Atlas and installs it into an Obsidian vault.

.DESCRIPTION
	Obsidian keeps its known vaults in %APPDATA%\obsidian\obsidian.json, so this
	script can find them for you instead of making you type a path.

.EXAMPLE
	.\scripts\install.ps1 -List
	.\scripts\install.ps1
	.\scripts\install.ps1 -Vault "D:\Notes\MyVault" -WithDemo
#>
[CmdletBinding()]
param(
	# Path to the vault root (the folder that contains .obsidian).
	[string]$Vault,
	# Show the vaults Obsidian knows about, then exit.
	[switch]$List,
	# Skip npm run build and install whatever is already on disk.
	[switch]$NoBuild,
	# Also copy the demo canvas into the vault.
	[switch]$WithDemo
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pluginId = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).id

function Get-KnownVaults {
	$config = Join-Path $env:APPDATA "obsidian\obsidian.json"
	if (-not (Test-Path $config)) { return @() }
	$json = Get-Content $config -Raw | ConvertFrom-Json
	if ($null -eq $json.vaults) { return @() }
	$found = @()
	foreach ($entry in $json.vaults.PSObject.Properties) {
		$path = $entry.Value.path
		if ($path -and (Test-Path $path)) {
			$found += [pscustomobject]@{
				Name = Split-Path $path -Leaf
				Path = $path
				Open = [bool]$entry.Value.open
			}
		}
	}
	return $found | Sort-Object -Property @{Expression = "Open"; Descending = $true }, Name
}

# @() forces array semantics: a single vault comes back as a scalar otherwise,
# and .Count then does not mean what you expect.
$known = @(Get-KnownVaults)

if ($List) {
	if ($known.Count -eq 0) { Write-Host "No vaults found in $env:APPDATA\obsidian\obsidian.json" }
	else { $known | Format-Table Name, Open, Path -AutoSize }
	return
}

if (-not $Vault) {
	if ($known.Count -eq 0) {
		throw "No vault given and none found automatically. Pass -Vault 'C:\path\to\vault'."
	}
	if ($known.Count -eq 1) {
		$Vault = $known[0].Path
		Write-Host "Using the only vault found: $($known[0].Name)"
	}
	else {
		# More than one candidate: the wrong guess would write into someone's
		# real notes folder, so make the choice explicit rather than picking.
		Write-Host "Several vaults found. Re-run with -Vault, for example:" -ForegroundColor Yellow
		Write-Host ""
		$known | Format-Table Name, Open, Path -AutoSize
		Write-Host "  .\scripts\install.ps1 -Vault `"$($known[0].Path)`""
		return
	}
}

if (-not (Test-Path (Join-Path $Vault ".obsidian"))) {
	throw "'$Vault' does not look like a vault: no .obsidian folder inside it."
}

if (-not $NoBuild) {
	Write-Host "Building..."
	# "npm" alone can resolve to the shell shim rather than the launcher when
	# invoked with the call operator; npm.cmd is unambiguous on Windows.
	$npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
	Push-Location $root
	try {
		& $npm run build
		if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
	}
	finally { Pop-Location }
}

$target = Join-Path $Vault ".obsidian\plugins\$pluginId"
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($file in @("main.js", "manifest.json", "styles.css")) {
	$source = Join-Path $root $file
	if (-not (Test-Path $source)) { throw "Missing build output: $file. Run without -NoBuild." }
	Copy-Item $source -Destination $target -Force
	Write-Host "  -> $file"
}

if ($WithDemo) {
	# One folder, not six loose items in the vault root. The canvases point at
	# assets by path, so the whole tree has to move together.
	$pack = Join-Path $root "demo\Atlas"
	if (Test-Path $pack) {
		# Replace rather than merge: copying over the top leaves assets that the
		# demo no longer ships, and a canvas can end up pointing at a stale file.
		$dest = Join-Path $Vault "Atlas"
		if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
		Copy-Item $pack -Destination $Vault -Recurse -Force
		Write-Host "  -> Atlas\ (five decks, a theme and their assets)"
	}
	else {
		Write-Host "  !  demo\Atlas not found; skipping the demo." -ForegroundColor Yellow
	}
}

# .hotreload makes the Hot Reload plugin pick up rebuilds without restarting.
if (-not (Test-Path (Join-Path $target ".hotreload"))) {
	New-Item -ItemType File -Path (Join-Path $target ".hotreload") | Out-Null
}

Write-Host ""
Write-Host "Installed to $target" -ForegroundColor Green
Write-Host "In Obsidian: Settings -> Community plugins -> enable 'Atlas'."
Write-Host "To pick up this build, do one of:"
Write-Host "  - nothing, if the Hot Reload plugin is installed (this folder has its marker)"
Write-Host "  - Settings -> Community plugins -> toggle Atlas off and on"
Write-Host "  - Ctrl+P -> 'Reload app without saving'"
