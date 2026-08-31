# Patch Transfer

A safe VS Code workflow for transferring source-code changes into offline or air-gapped environments.

---

## Why Patch Transfer?

When developing software for secure, offline, or air-gapped environments:
- The source development machine often has internet access or remote Git repository access.
- The target offline environment is isolated and cannot connect to remote Git repositories.
- Source and destination repositories may have divergent or independent Git histories.
- Copying entire project folders between environments is slow, error-prone, and risks overwriting local configuration files.

**Patch Transfer** solves this by moving only precise, Git-validated source code diffs with full cryptographic verification and rollback capabilities.

---

## Features

- **Git-Based Binary-Safe Patch Creation**: Generates clean, standard unified patches including text, binary, additions, deletions, and renames.
- **Automated Source Workflow**: Stages, validates, generates patch, commits with custom or AI-assisted messages, and pushes to remote in one action.
- **Remembered Transfer Folder**: Configure an external drive, USB stick, or shared folder once per repository; patches and sidecar metadata transfer automatically.
- **SHA-256 Patch Identity & Deduplication**: Every patch is identified by the SHA-256 hash of its exact file contents, preventing duplicate imports and naming collisions.
- **Patch Status Lifecycle**: Real-time status classification:
  - `READY`: Valid patch that applies cleanly to current working tree.
  - `CREATED`: Patch generated locally on this source repository.
  - `APPLIED`: Patch has been successfully applied to the local project.
  - `CONFLICT`: Valid patch, but cannot cleanly apply against current local files.
  - `INVALID`: Malformed or unreadable patch file.
- **Non-Destructive Patch Preview**: Inspect affected files, change types (add/edit/delete/rename), and line statistics without modifying working-tree files.
- **Safe Patch Application**: Applies patches safely using Git mechanics without requiring matching branch histories.
- **Pre-Apply Snapshots & Rollback (Undo Last Patch)**: Automatically captures byte-exact snapshots of affected files before applying, enabling complete restoration of the previous state.
- **Post-Apply Fingerprint Protection**: Detects if files were manually modified after patch application and prompts before undoing.
- **Professional Conflict Diagnostics**: Identifies conflicting files, lines, and causes (e.g., context mismatch, missing files) with clean virtual document details and clipboard export.
- **Patch Chain Metadata & Gap Detection**: Links sequential patches linearly and warns if an imported patch is missing its predecessor.
- **Detailed Patch Inspection & Audit History**: Read-only timeline document of all `CREATED`, `IMPORTED`, `APPLIED`, and `UNDONE` events under `<git-dir>/patch-transfer/history.json`.
- **Support for Independent Git Histories**: Works seamlessly between repositories with different commit graphs or disconnected origins.

---

## Typical Workflow

### Source Machine (Connected)
1. Open your Git repository in VS Code.
2. Make code edits in the workspace.
3. Open the **Changes** view in the Patch Transfer activity bar sidebar.
4. Enter or generate a commit message in the Commit Composer.
5. Click **Create Patch** (or press `Ctrl+Enter`).
6. Changes are committed, pushed to your remote repository, and the `.patch` along with its `.patchmeta.json` sidecar are copied to your transfer folder.

### Offline / Target Machine (Air-Gapped)
1. Ensure Git is installed and available in `PATH`.
2. Open your local destination repository in VS Code (no remote connection required).
3. Open the **Patches** view in the Patch Transfer activity bar sidebar.
4. Click **Import Patch** to select your transfer folder/USB drive.
5. The extension discovers patches and validates their integrity.
6. Click **Preview Patch** to review affected files and changes.
7. Click **Apply Patch** to apply changes to your project.
8. If needed, click **Undo Last Patch** to revert back to the exact pre-apply state.

> [!NOTE]
> A remote Git repository is **not required** on the offline machine. A simple local Git repository is sufficient.

---

## Patch Safety

- **Exact Byte Identity**: SHA-256 identities are computed directly from complete patch bytes. Metadata is strictly external and never alters patch content.
- **Duplicate Protection**: Importing or copying the same patch multiple times is detected and deduplicated safely.
- **Atomic Pre-Apply Snapshots**: Exact file contents are snapshotted before Git apply runs; if application fails, the working tree remains untouched.
- **Advisory Predecessor Warnings**: Missing chain predecessors trigger advisory warnings without blocking Git applicability.
- **Metadata Isolation**: Imported metadata is treated as untrusted input and validated against actual patch bytes.

---

## Conflict Diagnostics

When a patch cannot apply cleanly against the current state of destination files:
- The patch is classified as `CONFLICT`.
- Click **Conflict Details** (`$(issues)`) to view a comprehensive diagnostic report detailing which files conflict, line numbers, and specific reasons (e.g., context mismatch, missing target file, file already exists).
- Click **Copy Conflict Diagnostics** to export a clean report to your clipboard.

> [!NOTE]
> Patch Transfer diagnoses conflicts with high precision. It does not perform automatic conflict resolution.

---

## Requirements

- **VS Code**: Version `^1.134.0` or higher.
- **Git**: Git must be installed and accessible in your system `PATH`.
- **Source Repository**: Remote access is only required if the commit/push workflow is used.
- **Destination Repository**: Can be entirely offline with zero network connectivity.

---

## Offline / Air-Gapped Use

Patches and sidecar metadata files can be transported using USB drives, secure removable media, or internal file transfer portals. Patch Transfer performs all operations locally and initiates **no network connections**.

---

## Security Model

- **Zero Network Telemetry**: Patch Transfer contains no telemetry, analytics, or background tracking.
- **No Cloud Backend**: All state management, snapshotting, and history logs are stored strictly on the local machine within the repository's `.git/patch-transfer/` directory.
- **Display-Only Metadata**: Metadata file paths are never used for filesystem operations or command execution.
- **Local Exclusion**: Local patch artifacts under `.patch-transfer/` are automatically excluded from Git commits via `.git/info/exclude`.

---

## Limitations

- Automatic conflict resolution is not implemented; manual alignment or prerequisite patching is recommended.
- Rollback restoration is available for the most recently applied patch with valid snapshot data.
- Git must be installed on both source and destination machines.

---

## License

This project is licensed under the [MIT License](LICENSE).
