import { randomBytes } from 'crypto';
import { join } from 'path';
import * as vscode from 'vscode';
import { ConflictDiffProvider } from './conflictDiffProvider';
import {
	ConflictResolutionService,
	HunkResolution,
	ResolutionHunk,
	ResolutionSession,
} from './conflictResolutionService';

export class ConflictResolverPanel implements vscode.Disposable {
	public static currentPanel: ConflictResolverPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private session: ResolutionSession;
	private disposed = false;

	private constructor(
		panel: vscode.WebviewPanel,
		session: ResolutionSession,
		private readonly repositoryPath: string,
		private readonly resolutionService: ConflictResolutionService,
		private readonly diffProvider: ConflictDiffProvider,
		private readonly onApplied: () => Promise<void>,
	) {
		this.panel = panel;
		this.session = session;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			async message => {
				await this.handleMessage(message);
			},
			null,
			this.disposables,
		);

		this.render();
	}

	public static async show(
		extensionUri: vscode.Uri,
		repositoryPath: string,
		patchPath: string,
		resolutionService: ConflictResolutionService,
		diffProvider: ConflictDiffProvider,
		onApplied: () => Promise<void>,
	): Promise<ConflictResolverPanel> {
		if (ConflictResolverPanel.currentPanel) {
			// If a panel already exists, cancel the old session and start a new one
			const existingPanel = ConflictResolverPanel.currentPanel;
			await existingPanel.resolutionService.cancelSession(existingPanel.session);
			const newSession = await resolutionService.startSession(repositoryPath, patchPath);
			existingPanel.session = newSession;
			existingPanel.render();
			existingPanel.panel.reveal(vscode.ViewColumn.Active);
			return existingPanel;
		}

		const session = await resolutionService.startSession(repositoryPath, patchPath);

		const panel = vscode.window.createWebviewPanel(
			'patchTransfer.conflictResolver',
			'Patch Conflict Resolver',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		ConflictResolverPanel.currentPanel = new ConflictResolverPanel(
			panel,
			session,
			repositoryPath,
			resolutionService,
			diffProvider,
			onApplied,
		);

		return ConflictResolverPanel.currentPanel;
	}

	private async handleMessage(message: {
		command: string;
		hunkId?: string;
		filePath?: string;
		resolution?: HunkResolution;
		choice?: 'current' | 'patch-safe';
		customText?: string;
	}): Promise<void> {
		switch (message.command) {
			case 'resolveHunk': {
				if (message.hunkId && message.resolution) {
					try {
						await this.resolutionService.setHunkResolution(
							this.session,
							message.hunkId,
							message.resolution,
							message.customText,
						);
						this.render();
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : String(err);
						void vscode.window.showErrorMessage(errorMsg);
					}
				}
				break;
			}
			case 'resolveFile': {
				if (message.filePath && message.choice) {
					try {
						await this.resolutionService.setFileResolution(
							this.session,
							message.filePath,
							message.choice,
						);
						this.render();
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : String(err);
						void vscode.window.showErrorMessage(errorMsg);
					}
				}
				break;
			}
			case 'openDiff': {
				if (message.hunkId) {
					const hunk = this.findHunk(message.hunkId);
					if (hunk) {
						await this.diffProvider.showDiff(
							hunk.filePath,
							`Conflict ${hunk.hunkIndex + 1}`,
							hunk.currentText,
							hunk.patchNewText,
						);
					}
				}
				break;
			}
			case 'resolveManually': {
				if (message.filePath) {
					const candidatePath = join(this.session.resolvedDir, message.filePath);
					try {
						const doc = await vscode.workspace.openTextDocument(candidatePath);
						await vscode.window.showTextDocument(doc);
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : String(err);
						void vscode.window.showErrorMessage(`Could not open candidate file: ${errorMsg}`);
					}
				}
				break;
			}
			case 'markFileResolved': {
				if (message.filePath) {
					await this.resolutionService.markFileManualResolved(this.session, message.filePath);
					this.render();
				}
				break;
			}
			case 'applyResolved': {
				await this.applyResolved();
				break;
			}
			case 'cancel': {
				this.panel.dispose();
				break;
			}
		}
	}

	private async applyResolved(): Promise<void> {
		try {
			await this.resolutionService.applyResolved(this.session, this.repositoryPath);
			void vscode.window.showInformationMessage(
				`Patch applied successfully: ${this.session.patchFileName}`,
			);
			await this.onApplied();
			this.panel.dispose();
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes('The project changed while this conflict was being resolved.')) {
				const choice = await vscode.window.showWarningMessage(
					'The project changed while this conflict was being resolved.',
					{
						modal: true,
						detail: 'Your local files were modified outside the resolver. Applying now could overwrite newer work.',
					},
					'Re-analyze Conflicts',
					'Cancel',
				);

				if (choice === 'Re-analyze Conflicts') {
					await this.resolutionService.cancelSession(this.session);
					this.session = await this.resolutionService.startSession(
						this.repositoryPath,
						this.session.patchPath,
					);
					this.render();
				}
			} else {
				void vscode.window.showErrorMessage(`Failed to apply resolved patch: ${errorMsg}`);
			}
		}
	}

	private findHunk(hunkId: string): ResolutionHunk | undefined {
		for (const file of this.session.files) {
			const found = file.hunks.find(h => h.id === hunkId);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	private render(): void {
		const nonce = randomBytes(16).toString('base64');
		this.panel.webview.html = this.getHtmlContent(nonce);
	}

	private getHtmlContent(nonce: string): string {
		let totalConflicts = 0;
		let unresolvedCount = 0;
		let keepCurrentCount = 0;
		let usePatchCount = 0;
		let manualCount = 0;

		for (const file of this.session.files) {
			for (const hunk of file.hunks) {
				totalConflicts++;
				if (hunk.resolution === 'unresolved') {
					unresolvedCount++;
				} else if (hunk.resolution === 'current') {
					keepCurrentCount++;
				} else if (hunk.resolution === 'patch') {
					usePatchCount++;
				} else if (hunk.resolution === 'manual') {
					manualCount++;
				}
			}
		}

		const cleanChangesCount = this.session.cleanChanges ?? this.session.files.filter(f => f.status === 'clean').length;
		const totalFilesCount = this.session.files.length;
		const canApply = unresolvedCount === 0 && totalConflicts > 0;

		const filesHtml = this.session.files
			.filter(file => file.status === 'conflict')
			.map(file => this.renderFileCard(file))
			.join('\n');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Patch Conflict Resolver</title>
	<style>
		:root {
			--font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
			--font-size: var(--vscode-editor-font-size, 13px);
			--bg-color: var(--vscode-editor-background);
			--fg-color: var(--vscode-editor-foreground);
			--card-bg: var(--vscode-sideBar-background, #252526);
			--border-color: var(--vscode-widget-border, #3c3c3c);
			--button-bg: var(--vscode-button-background, #0e639c);
			--button-fg: var(--vscode-button-foreground, #ffffff);
			--button-hover: var(--vscode-button-hoverBackground, #1177bb);
			--secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
			--secondary-fg: var(--vscode-button-secondaryForeground, #ffffff);
			--secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
			--target-border: #4fc1ff;
			--incoming-border: #89d185;
			--badge-bg: var(--vscode-badge-background, #4d4d4d);
			--badge-fg: var(--vscode-badge-foreground, #ffffff);
			--warning-fg: var(--vscode-editorWarning-foreground, #cca700);
			--success-fg: var(--vscode-testing-iconPassed, #73c991);
		}

		body {
			font-family: var(--font-family);
			font-size: var(--font-size);
			background-color: var(--bg-color);
			color: var(--fg-color);
			margin: 0;
			padding: 24px 32px 100px 32px;
			box-sizing: border-box;
		}

		header {
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 16px;
			margin-bottom: 24px;
		}

		.header-title {
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-wrap: wrap;
			gap: 12px;
		}

		h1 {
			font-size: 18px;
			font-weight: 600;
			margin: 0;
		}

		.patch-badge {
			font-size: 13px;
			color: var(--vscode-descriptionForeground);
		}

		.status-pills {
			display: flex;
			gap: 10px;
			margin-top: 12px;
			flex-wrap: wrap;
		}

		.pill {
			background: var(--badge-bg);
			color: var(--badge-fg);
			padding: 4px 10px;
			border-radius: 12px;
			font-size: 12px;
			font-weight: 500;
		}

		.pill.warning {
			background: #5a4000;
			color: #ffd23f;
		}

		.pill.success {
			background: #1b4b27;
			color: #89d185;
		}

		.file-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 6px;
			margin-bottom: 24px;
			overflow: hidden;
		}

		.file-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 12px 16px;
			background-color: rgba(255, 255, 255, 0.03);
			border-bottom: 1px solid var(--border-color);
			flex-wrap: wrap;
			gap: 8px;
		}

		.file-path {
			font-weight: 600;
			font-size: 14px;
		}

		.file-actions {
			display: flex;
			gap: 8px;
		}

		.hunk-card {
			padding: 16px;
			border-bottom: 1px solid var(--border-color);
		}

		.hunk-card:last-child {
			border-bottom: none;
		}

		.hunk-title {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 12px;
		}

		.hunk-index {
			font-weight: 600;
			font-size: 13px;
		}

		.resolution-status {
			font-size: 12px;
			font-weight: 600;
		}

		.resolution-status.resolved {
			color: var(--success-fg);
		}

		.resolution-status.unresolved {
			color: var(--warning-fg);
		}

		.comparison-grid {
			display: grid;
			grid-template-columns: 1fr 1fr 1.2fr;
			gap: 16px;
			margin-bottom: 14px;
		}

		@media (max-width: 1000px) {
			.comparison-grid {
				grid-template-columns: 1fr;
			}
		}

		.pane-header {
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-bottom: 6px;
			display: flex;
			align-items: center;
			gap: 6px;
		}

		.target-label {
			color: var(--target-border);
		}

		.incoming-label {
			color: var(--incoming-border);
		}

		.result-label {
			color: #e5c07b;
		}

		.code-box {
			background: var(--bg-color);
			border: 1px solid var(--border-color);
			border-radius: 4px;
			padding: 8px 12px;
			margin: 0;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			line-height: 1.45;
			overflow-x: auto;
			white-space: pre-wrap;
			word-break: break-all;
			max-height: 240px;
		}

		.result-box {
			background: var(--bg-color);
			color: var(--fg-color);
			border: 1px solid #e5c07b;
			border-left: 3px solid #e5c07b;
			border-radius: 4px;
			padding: 8px 12px;
			margin: 0;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			line-height: 1.45;
			resize: vertical;
			width: 100%;
			box-sizing: border-box;
			min-height: 140px;
			max-height: 240px;
		}

		.primary-inline {
			background: var(--button-bg);
			color: var(--button-fg);
			border: 1px solid transparent;
			border-radius: 2px;
			padding: 4px 10px;
			font-size: 12px;
			cursor: pointer;
		}

		.primary-inline:hover {
			background: var(--button-hover);
		}

		.primary-inline.active {
			background: #1b4b27;
			border-color: #89d185;
		}


		.target-box {
			border-left: 3px solid var(--target-border);
		}

		.incoming-box {
			border-left: 3px solid var(--incoming-border);
		}

		.hunk-actions {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		button {
			font-family: var(--font-family);
			font-size: 12px;
			padding: 6px 12px;
			border: none;
			border-radius: 3px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}

		button.primary {
			background: var(--button-bg);
			color: var(--button-fg);
		}

		button.primary:hover:not(:disabled) {
			background: var(--button-hover);
		}

		button.secondary {
			background: var(--secondary-bg);
			color: var(--secondary-fg);
		}

		button.secondary:hover:not(:disabled) {
			background: var(--secondary-hover);
		}

		button.active {
			outline: 2px solid var(--target-border);
			font-weight: 600;
		}

		button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.sticky-footer {
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			background: var(--card-bg);
			border-top: 1px solid var(--border-color);
			padding: 14px 32px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
			flex-wrap: wrap;
			gap: 16px;
			z-index: 100;
		}

		.summary-text {
			font-size: 13px;
		}

		.summary-subtext {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-top: 3px;
		}

		.footer-actions {
			display: flex;
			gap: 10px;
		}
	</style>
</head>
<body>
	<header>
		<div class="header-title">
			<h1>Patch Conflict Resolver</h1>
			<div class="patch-badge">PATCH: <strong>${escapeHtml(this.session.patchFileName)}</strong></div>
		</div>
		<div class="status-pills">
			<div class="pill ${unresolvedCount > 0 ? 'warning' : 'success'}">
				${unresolvedCount > 0 ? `${unresolvedCount} unresolved conflict${unresolvedCount === 1 ? '' : 's'}` : 'All conflicts resolved'}
			</div>
			<div class="pill">Files changed: ${totalFilesCount}</div>
			<div class="pill">Clean changes: ${cleanChangesCount}</div>
			<div class="pill">Keep Current: ${keepCurrentCount}</div>
			<div class="pill">Use Patch: ${usePatchCount}</div>
			${manualCount > 0 ? `<div class="pill">Manual: ${manualCount}</div>` : ''}
		</div>
	</header>

	<main>
		${filesHtml}
	</main>

	<div class="sticky-footer">
		<div>
			<div class="summary-text">
				${unresolvedCount === 0 ? '✓ Ready to apply resolved patch' : `Resolve remaining ${unresolvedCount} conflict${unresolvedCount === 1 ? '' : 's'} to continue`}
			</div>
			<div class="summary-subtext">
				${cleanChangesCount} clean change${cleanChangesCount === 1 ? '' : 's'} will be automatically applied with chosen resolutions.
			</div>
		</div>
		<div class="footer-actions">
			<button id="btnCancel" class="secondary">Cancel</button>
			<button id="btnApply" class="primary" ${canApply ? '' : 'disabled'}>
				Apply Resolved Patch
			</button>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		document.addEventListener('click', event => {
			const target = event.target.closest('button');
			if (!target) return;

			const action = target.dataset.action;
			const hunkId = target.dataset.hunkId;
			const filePath = target.dataset.filePath;
			const choice = target.dataset.choice;

			if (action === 'acceptEditedResult') {
				const textarea = document.getElementById('result-box-' + hunkId);
				const customText = textarea ? textarea.value : '';
				vscode.postMessage({ command: 'resolveHunk', hunkId, resolution: 'manual', customText });
			} else if (action === 'resolveHunk') {
				const textarea = document.getElementById('result-box-' + hunkId);
				if (choice === 'current' && textarea) {
					const targetBox = target.closest('.hunk-card').querySelector('.target-box');
					if (targetBox) textarea.value = targetBox.textContent;
				} else if (choice === 'patch' && textarea) {
					const incomingBox = target.closest('.hunk-card').querySelector('.incoming-box');
					if (incomingBox) textarea.value = incomingBox.textContent;
				}
				vscode.postMessage({ command: 'resolveHunk', hunkId, resolution: choice });
			} else if (action === 'resolveFile') {
				vscode.postMessage({ command: 'resolveFile', filePath, choice });
			} else if (action === 'openDiff') {
				vscode.postMessage({ command: 'openDiff', hunkId });
			} else if (action === 'resolveManually') {
				vscode.postMessage({ command: 'resolveManually', filePath });
			} else if (action === 'markFileResolved') {
				vscode.postMessage({ command: 'markFileResolved', filePath });
			} else if (target.id === 'btnApply') {
				vscode.postMessage({ command: 'applyResolved' });
			} else if (target.id === 'btnCancel') {
				vscode.postMessage({ command: 'cancel' });
			}
		});
	</script>
</body>
</html>`;
	}

	private renderFileCard(file: import('./conflictResolutionService').ResolutionFile): string {
		const hunksHtml = file.hunks
			.map(hunk => this.renderHunkRow(file, hunk))
			.join('\n');

		return `
		<div class="file-card">
			<div class="file-header">
				<div class="file-path">📄 ${escapeHtml(file.filePath)}</div>
				<div class="file-actions">
					<button class="secondary" data-action="resolveFile" data-file-path="${escapeHtml(file.filePath)}" data-choice="current" title="Keep Current for All Conflicts in File">
						Keep Current for File
					</button>
					<button class="secondary" data-action="resolveFile" data-file-path="${escapeHtml(file.filePath)}" data-choice="patch-safe" title="Use Patch Change for All Safe Conflicts in File">
						Use Patch for All Safe
					</button>
					<button class="secondary" data-action="resolveManually" data-file-path="${escapeHtml(file.filePath)}" title="Edit candidate file in editor">
						Edit Result
					</button>
					<button class="secondary" data-action="markFileResolved" data-file-path="${escapeHtml(file.filePath)}" title="Mark this file as resolved">
						Mark File Resolved
					</button>
				</div>
			</div>
			<div class="file-hunks">
				${hunksHtml}
			</div>
		</div>`;
	}

	private renderHunkRow(
		file: import('./conflictResolutionService').ResolutionFile,
		hunk: ResolutionHunk,
	): string {
		const isCurrent = hunk.resolution === 'current';
		const isPatch = hunk.resolution === 'patch';
		const isManual = hunk.resolution === 'manual' || file.manualResolved;
		const isUnresolved = hunk.resolution === 'unresolved' && !file.manualResolved;

		let statusBadge = '';
		if (isCurrent) {
			statusBadge = '<span class="resolution-status resolved">✓ RESOLVED (Keep Current)</span>';
		} else if (isPatch) {
			statusBadge = '<span class="resolution-status resolved">✓ RESOLVED (Patch Change)</span>';
		} else if (isManual) {
			statusBadge = '<span class="resolution-status resolved">✓ RESOLVED (Edited Result)</span>';
		} else {
			statusBadge = '<span class="resolution-status unresolved">⚠ Unresolved</span>';
		}

		const patchButtonTitle = hunk.canApplyPatchAutomatically
			? 'Apply incoming patch change'
			: `Manual edit required: ${hunk.unsafeReason || 'Conflict cannot be matched deterministically'}`;

		const resultValue = hunk.customResultText !== undefined
			? hunk.customResultText
			: (hunk.resolution === 'patch' ? hunk.patchNewText : hunk.currentText);

		return `
		<div class="hunk-card">
			<div class="hunk-title">
				<span class="hunk-index">Conflict ${hunk.hunkIndex + 1} of ${file.hunks.length}</span>
				${statusBadge}
			</div>

			<div class="comparison-grid">
				<div class="grid-pane">
					<div class="pane-header target-label">CURRENT (TARGET)</div>
					<pre class="code-box target-box">${escapeHtml(hunk.currentText || '(empty / file does not exist)')}</pre>
				</div>
				<div class="grid-pane">
					<div class="pane-header incoming-label">PATCH (INCOMING)</div>
					<pre class="code-box incoming-box">${escapeHtml(hunk.patchNewText || '(empty / deleted)')}</pre>
				</div>
				<div class="grid-pane result-pane">
					<div class="pane-header result-label">RESULT (EDITABLE)</div>
					<textarea class="result-box" id="result-box-${escapeHtml(hunk.id)}" rows="8">${escapeHtml(resultValue)}</textarea>
				</div>
			</div>

			<div class="hunk-actions">
				<button class="secondary ${isCurrent ? 'active' : ''}" data-action="resolveHunk" data-hunk-id="${escapeHtml(hunk.id)}" data-choice="current" title="Keep Current target code for this conflict">
					${isCurrent ? '✓ Keep Current' : 'Keep Current'}
				</button>
				<button class="secondary ${isPatch ? 'active' : ''}" data-action="resolveHunk" data-hunk-id="${escapeHtml(hunk.id)}" data-choice="patch" ${hunk.canApplyPatchAutomatically ? '' : 'disabled'} title="${escapeHtml(patchButtonTitle)}">
					${isPatch ? '✓ Use Patch Change' : hunk.canApplyPatchAutomatically ? 'Use Patch Change' : 'Edit Result required'}
				</button>
				<button class="primary-inline ${isManual ? 'active' : ''}" data-action="acceptEditedResult" data-hunk-id="${escapeHtml(hunk.id)}" title="Use this edited RESULT for this conflict">
					${isManual ? '✓ Result Accepted' : 'Accept Edited Result'}
				</button>
				<button class="secondary" data-action="resolveManually" data-file-path="${escapeHtml(file.filePath)}" title="Open candidate file in VS Code editor">
					Edit in Editor
				</button>
				<button class="secondary" data-action="openDiff" data-hunk-id="${escapeHtml(hunk.id)}" title="Open comparison in VS Code diff editor">
					Open Diff
				</button>
			</div>
		</div>`;
	}


	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		ConflictResolverPanel.currentPanel = undefined;
		void this.resolutionService.cancelSession(this.session);
		this.panel.dispose();
		while (this.disposables.length) {
			const d = this.disposables.pop();
			if (d) {
				d.dispose();
			}
		}
	}
}

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
