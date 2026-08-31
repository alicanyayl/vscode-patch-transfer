# VS Code Marketplace Release Guide

This document outlines the step-by-step procedure to publish **Patch Transfer** to the Visual Studio Code Marketplace.

---

## 1. Create a Marketplace Publisher

1. Open the [Visual Studio Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Sign in with your Microsoft account.
3. Click **Create publisher**.
4. Choose a unique **Publisher ID** (e.g., `alicanyayli`).
   > [!IMPORTANT]
   > The Publisher ID cannot be changed once created. Choose carefully.
5. Fill in the required display name and contact details.

---

## 2. Update `package.json`

Open `package.json` in the extension root and replace the placeholder with your exact Publisher ID:

```json
"publisher": "your-publisher-id"
```

---

## 3. Build & Package the Extension

Run the complete compilation, test suite, and packaging script:

```bash
# 1. Compile and lint
pnpm run compile

# 2. Run all tests
pnpm test

# 3. Production build
pnpm run package

# 4. Generate the VSIX package
pnpm dlx @vscode/vsce package
```

This will produce `patch-transfer-0.1.0.vsix` in the project root.

---

## 4. Manual Upload to Marketplace

1. Navigate back to the [Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Select your publisher.
3. Click **New extension** -> **Visual Studio Code**.
4. Drag and drop `patch-transfer-0.1.0.vsix` (or click Browse to select it).
5. Wait for the Marketplace verification and publishing process (typically 2–5 minutes).
6. Once published, your extension will be publicly discoverable in the VS Code Extensions tab.
