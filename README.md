# Patch Transfer

Patch Transfer is a VS Code extension for transferring Git-based code changes between independent online and offline repositories.

## Features

- View Git working-tree changes
- Write or generate a commit message
- Create timestamped patch files
- Automatically commit and push source changes
- Copy patches to external folders or USB drives
- Import patches into another repository
- Detect duplicate patches using SHA-256
- Show patch status as Created, Ready, Applied, Conflict, or Invalid
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
4. Optionally select **Copy To...** and copy the patch to a USB drive.

Destination repository:

1. Select **Import Patch**.
2. Choose the patch file.
3. Confirm the patch is **Ready**.
4. Select **Apply Patch**.

Patch files are stored locally under:

`.patch-transfer/`

Applied and created patch state is stored inside the repository Git directory.

## Notes

Patch Transfer is designed for repositories that may have independent Git histories.

The destination repository is not automatically committed or pushed after a patch is applied.
