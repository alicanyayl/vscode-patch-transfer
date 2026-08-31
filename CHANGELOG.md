# Changelog

All notable changes to the **Patch Transfer** extension will be documented in this file.

## [0.1.0] - 2026-08-31

### Added
- **Unified Changes View**: Interactive sidebar view displaying modified, added, deleted, renamed, and untracked files with status indicators.
- **Commit Composer**: Built-in commit message editor with optional AI assistance and `Ctrl+Enter` shortcut.
- **Patch Creation & Export Workflow**: One-click generation of unified binary-safe patches with automated commit and push.
- **Persistent Transfer Folder**: Configurable per-repository transfer directory for automated patch and metadata copying to USB/removable drives.
- **SHA-256 Patch Identity & Deduplication**: Cryptographic identification and duplicate import protection across repositories.
- **Live Patch Status Classification**: Real-time evaluation of patches into `READY`, `CREATED`, `APPLIED`, `CONFLICT`, and `INVALID` states.
- **Non-Destructive Patch Preview**: Read-only inspection of affected files, change types, additions, and deletions.
- **Safe Patch Application**: Git-based patch application compatible with independent repository histories.
- **Rollback Snapshots & Undo Last Patch**: Pre-apply file snapshots allowing complete restoration of the previous project state.
- **Post-Apply Fingerprint Verification**: Detection of post-apply file modifications prior to rollback.
- **Professional Conflict Diagnostics**: Detailed line-level conflict analysis with virtual document presentation and clipboard export.
- **Patch Chain Metadata & Gap Detection**: Sidecar metadata (`.patchmeta.json`) linking sequential patches linearly with missing-predecessor warnings.
- **Patch Details Inspection**: Detailed metadata viewer (`Show Patch Details`) showing source commits, branches, statistics, and affected paths.
- **Audit History Log**: Chronological local history log under `<git-dir>/patch-transfer/history.json` accessible via `Show History`.
- **Git State Area Isolation**: Automatic `.git/info/exclude` management ensuring local transfer artifacts remain untracked.