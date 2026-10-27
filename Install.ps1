[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $VaultPath,
    [string] $ConfigDir = '.obsidian'
)

$ErrorActionPreference = 'Stop'

function Assert-NoReparsePoint {
    param([string] $Root, [string] $Target)
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedTarget = [IO.Path]::GetFullPath($Target)
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    if ($resolvedTarget -ne $resolvedRoot -and -not $resolvedTarget.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Het doel ligt buiten de opgegeven vault.'
    }
    $relative = $resolvedTarget.Substring($resolvedRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
    $current = $resolvedRoot
    $parts = @('') + @($relative -split '[\\/]' | Where-Object { $_ -ne '' })
    foreach ($part in $parts) {
        if ($part -ne '') { $current = Join-Path $current $part }
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Symbolische link of junction wordt geweigerd: $current"
            }
        }
    }
}

if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
    throw 'De opgegeven vaultmap bestaat niet.'
}
$vault = (Get-Item -LiteralPath $VaultPath -Force).FullName
if ([IO.Path]::IsPathRooted($ConfigDir)) { throw 'ConfigDir moet relatief aan de vault zijn.' }
$configParts = @($ConfigDir -split '[\\/]')
foreach ($part in $configParts) {
    if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:"|?*\x00-\x1f]' -or $part -match '[. ]$') {
        throw 'ConfigDir bevat een ongeldig padonderdeel.'
    }
}
$pluginId = 'drive-vault-sync'
$source = Join-Path $PSScriptRoot $pluginId
if (-not (Test-Path -LiteralPath (Join-Path $source 'manifest.json'))) { $source = $PSScriptRoot }
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.id -ne $pluginId) { throw 'Het manifest hoort niet bij Drive Vault Sync.' }
$checksums = Get-Content -LiteralPath (Join-Path $source 'checksums.json') -Raw | ConvertFrom-Json
$files = @('main.js', 'manifest.json', 'styles.css')
foreach ($name in $files) {
    $expected = $checksums.$name
    if ($expected -notmatch '^[a-f0-9]{64}$') { throw "Controlehash ontbreekt: $name" }
    $actual = (Get-FileHash -LiteralPath (Join-Path $source $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Bestandscontrole mislukt: $name" }
}
$target = [IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $vault $ConfigDir) 'plugins') $pluginId))
Assert-NoReparsePoint -Root $vault -Target $target
foreach ($name in $files) { Assert-NoReparsePoint -Root $vault -Target (Join-Path $target $name) }

if ($PSCmdlet.ShouldProcess($target, 'Drie pluginbestanden installeren of bijwerken; bestaande instellingen behouden')) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $backup = Join-Path (Join-Path $target '.install-backups') $stamp
    Assert-NoReparsePoint -Root $vault -Target $backup
    foreach ($name in $files) {
        $destination = Join-Path $target $name
        if (Test-Path -LiteralPath $destination) {
            New-Item -ItemType Directory -Path $backup -Force | Out-Null
            Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $name)
        }
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination -Force
    }
    Write-Output "Geinstalleerd: $target"
    Write-Output 'Open Obsidian opnieuw en schakel Drive Vault Sync in bij Community plugins.'
    Write-Output 'Bestaande data.json, sync-state.json en Google-aanmelding zijn behouden.'
}
