# Patch Transfer

Patch Transfer is a VS Code extension for transferring Git-based code changes between independent online and offline repositories.

## Features

- View Git working-tree changes
- Write or generate a commit message
- Create timestamped patch files
- Automatically commit and push source changes
- Remember a repository-specific transfer folder
- Automatically copy patches to external folders or USB drives
- Import available patches from the remembered transfer folder
- Detect duplicate patches using SHA-256
- Show patch status as Created, Ready, Applied, Conflict, or Invalid
- Preview affected files and line statistics without modifying the project
- Apply patches safely without requiring matching Git histories
- Keep `.patch-transfer/` local through Git `info/exclude`

## Requirements

- Git must be installed and available in PATH
- VS Code
- Copilot is optional and only used for AI commit-message generation

## Usage

Source repository:

1. Edit files.
2. Enter or generate a commit message.
3. Select **Create Patch**.
4. On first use, select a transfer folder. Future patches are copied there automatically.

Destination repository:

1. Select **Import Patch** and choose a transfer folder on first use.
2. Future imports scan that remembered folder automatically.
3. Confirm an imported patch is **Ready**.
4. Select **Preview Patch** to inspect affected files and line statistics.
5. Select **Apply Patch** to modify the destination project.

Use **Set Transfer Folder** from either view title to change the remembered folder.

Patch files are stored locally under:

`.patch-transfer/`

Applied and created patch state is stored inside the repository Git directory.

## Notes

Patch Transfer is designed for repositories that may have independent Git histories.

The destination repository is not automatically committed or pushed after a patch is applied.
