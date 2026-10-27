# Drive Vault Sync for Obsidian

Drive Vault Sync is a desktop-only Obsidian plugin that synchronizes a vault with a normal folder in Google Drive. Every run downloads and validates remote changes first, then uploads local changes. Conflicting content is kept as two files instead of being discarded.

Version **1.2.1** includes a theme-aware progress popup, safe pull-first synchronization, recovery copies, optional trash propagation, and a final sync before Obsidian closes.

> This is an independently developed community plugin. It is not affiliated with or endorsed by Obsidian or Google.

## Features

- Pull-first, bidirectional synchronization between one Obsidian vault and one Google Drive folder.
- Content comparison against a known baseline, rather than relying only on modification times.
- Both versions preserved on conflicts, including recovery copies before overwrites and deletions.
- Automatic synchronization after local changes, on window focus, at a configurable interval, and at Obsidian startup.
- A bounded final synchronization when Obsidian's vault window closes.
- Progress popup with the current phase, file, completed count, and Stop and Hide controls.
- Theme-aware UI using Obsidian CSS variables; the progress UI stays within narrow notification surfaces.
- Deletions disabled by default. When enabled, confirmed deletions use the trash and a guard limits bulk deletion.
- Files up to 100 MiB, with resumable uploads for files above 5 MiB.
- Desktop OAuth with PKCE and storage of credentials in Obsidian SecretStorage.

## Installation

1. Download the latest installation ZIP from the [Releases](https://github.com/NandSch/Obsidian-Google-Drive-Sync-Plugin/releases) page, or clone this repository and copy the three runtime files.
2. Close Obsidian.
3. Copy `main.js`, `manifest.json`, and `styles.css` into:

   `YOUR_VAULT/.obsidian/plugins/drive-vault-sync/`

4. Reopen Obsidian and enable **Drive Vault Sync** under **Community plugins**.

The included `Install.ps1` can install or update the three runtime files while preserving settings and synchronization state:

```powershell
.\Install.ps1 -VaultPath 'C:\path\to\Your Vault'
```

Use `-ConfigDir` for a custom Obsidian configuration directory and `-WhatIf` to preview the installation.

## Google Drive setup

The plugin uses your own Google Cloud project and communicates directly with Google Drive.

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Drive API**.
3. Configure Google Auth Platform with your app name, support email, and your own account as a test user if the app remains in Testing mode.
4. Add the scope `https://www.googleapis.com/auth/drive` in the plugin instructions. The broad scope is required to discover files added outside the plugin inside the selected Drive folder. The plugin constrains its file operations to that folder.
5. Create an OAuth client of type **Desktop app**.
6. In Obsidian, paste the client ID and the link or ID of a dedicated folder in **My Drive**. Save the client secret separately; it is stored in SecretStorage.
7. Sign in, preview the first synchronization, and then enable automatic synchronization after reviewing the proposed changes.

Do not point the plugin at your entire Drive or at a folder containing unrelated documents. Use a dedicated vault folder.

## Synchronization behavior

Each vault is compared using three states: the current local files, the current Drive files, and the last synchronized baseline.

- A remote-only change is downloaded after its ETag, checksum, size, and location are verified.
- A local-only change is uploaded after all planned downloads finish.
- A simultaneous change on both sides preserves the Drive version under the original name and the local version under a conflict-copy name.
- With deletion propagation disabled, files missing on one side are restored. With it enabled, only confirmed unchanged deletions use the trash, subject to a bulk-deletion limit.

The comparison scans the complete selected tree. Content hashes detect changes accurately; very large vaults will take longer on each run.

## Security and privacy

Drive credentials and OAuth tokens are stored in Obsidian SecretStorage, not in the vault's regular settings. Vault content is uploaded as ordinary files to the Drive folder you configure. The plugin has no telemetry, proxy server, or end-to-end encryption layer.

Review the Google scope and the selected folder before enabling automatic synchronization. Keep independent backups of important notes.

## Development

Requirements: Node.js 22 or newer.

```powershell
npm ci --ignore-scripts
npm run check
& './tests/installer.test.ps1'
```

`npm run check` performs strict TypeScript checking, builds `main.js`, and runs the local test suite. The current version passes 135 automated tests and 6 installer tests.

Source layout:

- `src/main.ts`: Obsidian lifecycle, scheduler, settings, popup coordination, and close integration.
- `src/engine.ts`: three-way planning, pull-first execution, conflict handling, and checkpoints.
- `src/drive.ts`: Drive API access, inventory validation, conditional writes, and resumable uploads.
- `src/local.ts`: Obsidian vault adapter, editor checks, and recovery copies.
- `src/auth.ts`: browser OAuth with PKCE and SecretStorage.
- `src/progress.ts` and `src/progress-view.ts`: phase tracking and the theme-aware UI.
- `tests/`: unit and integration coverage using temporary files and a mocked Drive API.

See [LEESMIJ.md](LEESMIJ.md) for the full Dutch installation guide, [ARCHITECTUUR.md](ARCHITECTUUR.md) for design decisions, and [TESTVERSLAG.md](TESTVERSLAG.md) for validation scope and limitations.

## Current validation limits

The synchronization engine and local file operations are covered by automated tests. Google Drive is mocked in those tests: a real token exchange, a real Drive folder, and a complete end-to-end run with a live account still need validation in a small trial vault. The final-close integration is based on the installed Obsidian desktop lifecycle and automated event tests.

## License

[MIT](LICENSE)
