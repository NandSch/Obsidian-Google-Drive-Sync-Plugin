$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testParent = [IO.Path]::GetFullPath((Join-Path $project '.test-build'))
New-Item -ItemType Directory -Path $testParent -Force | Out-Null
$sandbox = Join-Path $testParent ('installer-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$installer = Join-Path $project 'Install.ps1'
$passed = 0
try {
    $vault = Join-Path $sandbox 'Vault'
    New-Item -ItemType Directory -Path $vault | Out-Null
    & $installer -VaultPath $vault -WhatIf
    if (Test-Path -LiteralPath (Join-Path $vault '.obsidian')) { throw 'WhatIf changed the vault.' }
    $passed++
    & $installer -VaultPath $vault
    $target = Join-Path $vault '.obsidian/plugins/drive-vault-sync'
    foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
        if ((Get-FileHash -LiteralPath (Join-Path $target $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $project $name)).Hash) { throw "Installed bytes differ: $name" }
    }
    $passed++
    Set-Content -LiteralPath (Join-Path $target 'data.json') -Value 'preserve-settings'
    Set-Content -LiteralPath (Join-Path $target 'sync-state.json') -Value 'preserve-state'
    & $installer -VaultPath $vault
    if ((Get-Content -LiteralPath (Join-Path $target 'data.json') -Raw).Trim() -ne 'preserve-settings') { throw 'Settings overwritten.' }
    if ((Get-Content -LiteralPath (Join-Path $target 'sync-state.json') -Raw).Trim() -ne 'preserve-state') { throw 'State overwritten.' }
    if (-not (Test-Path -LiteralPath (Join-Path $target '.install-backups'))) { throw 'Update backup missing.' }
    $passed++
    & $installer -VaultPath $vault -ConfigDir '.custom'
    if (-not (Test-Path -LiteralPath (Join-Path $vault '.custom/plugins/drive-vault-sync/main.js'))) { throw 'Custom config path failed.' }
    $passed++
    $rejected = $false
    try { & $installer -VaultPath $vault -ConfigDir '../outside' } catch { $rejected = $true }
    if (-not $rejected) { throw 'Path traversal accepted.' }
    $passed++
    $corrupt = Join-Path $sandbox 'corrupt-package'
    $corruptPlugin = Join-Path $corrupt 'drive-vault-sync'
    New-Item -ItemType Directory -Path $corruptPlugin -Force | Out-Null
    Copy-Item -LiteralPath $installer -Destination (Join-Path $corrupt 'Install.ps1')
    foreach ($name in @('main.js','manifest.json','styles.css','checksums.json')) { Copy-Item -LiteralPath (Join-Path $project $name) -Destination (Join-Path $corruptPlugin $name) }
    Add-Content -LiteralPath (Join-Path $corruptPlugin 'main.js') -Value 'tampered'
    $rejected = $false
    try { & (Join-Path $corrupt 'Install.ps1') -VaultPath $vault } catch { $rejected = $true }
    if (-not $rejected) { throw 'Corrupted package accepted.' }
    $passed++
    Write-Output "Installer tests: $passed passed, 0 failed."
} finally {
    $resolvedSandbox = [IO.Path]::GetFullPath($sandbox)
    $allowedPrefix = $testParent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedSandbox.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean a path outside the test parent.' }
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
}
