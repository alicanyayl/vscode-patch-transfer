# Changelog

All notable changes to the **Patch Transfer** extension will be documented in this file.

## [0.2.0] - 2026-09-04

### Added
- **Interactive Conflict Resolver**: Webview panel providing Git-like side-by-side interactive resolution for conflicting patches.
- **Git-Like Current vs Patch Choices**: Review conflicts with clear `CURRENT (TARGET)` versus `PATCH (INCOMING)` presentation and deterministic choices (`Keep Current`, `Use Patch Change`, `Open Diff`, `Resolve Manually`).
- **Safe Partial Conflict Resolution**: Isolated sandbox partial-apply analysis (`git apply --reject` in private internal Git storage) automatically applies non-conflicting files and hunks without modifying the real project during resolution.
- **Manual Resolution Workflow**: Safely edit candidate files pre-populated with clean hunks in a temporary workspace and mark resolved before final application.
- **Transactional Resolved Apply**: Rollback snapshot capture prior to final apply ensures atomic application or automatic rollback upon failure.
- **Full Undo Integration**: Conflict-resolved patches seamlessly support `Undo Last Patch` and audit history tracking.
- **Deterministic Hunk Safety & Ambiguity Guard**: Unambiguous, anchor-validated hunks can be applied with one click; ambiguous or unanchored hunks require manual resolution instead of guessing.

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