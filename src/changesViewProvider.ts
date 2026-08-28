import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import {
	CommitMessageManager,
	CommitMessageSession,
	CommitMessageSnapshot,
} from './commitMessageManager';
import { ChangesSnapshot, ChangesViewModel } from './changesViewModel';

const viewId = 'patch-transfer.changes';
export const createPatchCommand = 'patch-transfer.createPatch';

export type ChangesViewMessage =
	| { type: 'viewReady' }
	| { type: 'commitMessageChanged'; value: string }
	| { type: 'generateCommitMessage' }
	| { type: 'createPatch' }
	| { type: 'openChangedFile'; path: string };

export function getChangesViewCommand(message: ChangesViewMessage): string | undefined {
	return message.type === 'createPatch' ? createPatchCommand : undefined;
}

export function createCommitMessageWebviewMessage(snapshot: CommitMessageSnapshot): {
	type: 'setCommitMessage';
	value: string;
} {
	return { type: 'setCommitMessage', value: snapshot.message };
}

export class ChangesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];
	private operationBusy = false;
	private generationBusy = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly messageManager: CommitMessageManager,
		private readonly changesModel: ChangesViewModel,
	) {}

	get count(): number {
		return this.changesModel.count;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.disposeViewListeners();
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.updateBadge();

		this.viewDisposables.push(
			webviewView.webview.onDidReceiveMessage(message => {
				const changesMessage = this.parseMessage(message);
				if (changesMessage) {
					void this.handleMessage(changesMessage);
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void Promise.all([this.refreshRepository(), this.refreshChanges(true)]);
				}
			}),
			webviewView.onDidDispose(() => {
				if (this.view === webviewView) {
					this.view = undefined;
				}
				this.disposeViewListeners();
			}),
		);
	}

	async refreshChanges(forcePost = false): Promise<void> {
		const changed = await this.changesModel.refresh();
		this.updateBadge();
		if (changed || forcePost) {
			this.postChangesSnapshot(this.changesModel.snapshot);
		}
	}

	async refreshRepository(): Promise<CommitMessageSnapshot> {
		const snapshot = await this.messageManager.refreshRepository();
		this.postCommitSnapshot(snapshot);
		return snapshot;
	}

	async beginCreatePatch(): Promise<CommitMessageSession> {
		const session = await this.messageManager.beginCreatePatch();
		this.postCommitSnapshot(session);
		return session;
	}

	completeCreatePatch(session: CommitMessageSession, commitSucceeded: boolean): void {
		session.complete(commitSucceeded);
		this.postCommitSnapshot(this.messageManager.getSnapshot());
	}

	setOperationBusy(busy: boolean): void {
		this.operationBusy = busy;
		this.postBusyState();
	}

	async focusCommitMessage(): Promise<void> {
		await vscode.commands.executeCommand(`${viewId}.focus`);
		void this.view?.webview.postMessage({ type: 'focusCommitMessage' });
	}

	dispose(): void {
		this.disposeViewListeners();
		this.view = undefined;
	}

	private async handleMessage(message: ChangesViewMessage): Promise<void> {
		const command = getChangesViewCommand(message);
		if (command) {
			await vscode.commands.executeCommand(command);
			return;
		}

		switch (message.type) {
			case 'viewReady':
				await Promise.all([this.refreshRepository(), this.refreshChanges(true)]);
				break;
			case 'commitMessageChanged':
				if (!(await this.messageManager.updateCommitMessage(message.value))) {
					this.postCommitSnapshot({ repositoryAvailable: false, message: '' });
				}
				break;
			case 'generateCommitMessage':
				await this.generateCommitMessage();
				break;
			case 'openChangedFile':
				await this.openChangedFile(message.path);
				break;
			case 'createPatch':
				break;
		}
	}

	private async openChangedFile(changePath: string): Promise<void> {
		const filePath = this.changesModel.getOpenableFilePath(changePath);
		if (filePath) {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
		}
	}

	private async generateCommitMessage(): Promise<void> {
		if (this.generationBusy || this.operationBusy) {
			return;
		}

		this.generationBusy = true;
		this.postBusyState();
		try {
			const result = await this.messageManager.generateCommitMessage();
			switch (result.status) {
				case 'generated':
					this.postCommitSnapshot({ repositoryAvailable: true, message: result.message });
					break;
				case 'noResult':
					this.postCommitSnapshot({ repositoryAvailable: true, message: result.message });
					void vscode.window.showInformationMessage(
						'Copilot did not return a commit message. You can try again or enter one manually.',
					);
					break;
				case 'unavailable':
					void vscode.window.showInformationMessage(
						'AI commit message generation is not available. You can enter the message manually.',
					);
					break;
				case 'noRepository':
					this.postCommitSnapshot({ repositoryAvailable: false, message: '' });
					void vscode.window.showInformationMessage('Git repository not found');
					break;
			}
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			void vscode.window.showInformationMessage(
				`AI commit message generation could not be completed: ${details} You can enter the message manually.`,
			);
		} finally {
			this.generationBusy = false;
			this.postBusyState();
		}
	}

	private postCommitSnapshot(snapshot: CommitMessageSnapshot): void {
		void this.view?.webview.postMessage({
			type: 'setRepositoryAvailable',
			available: snapshot.repositoryAvailable,
		});
		void this.view?.webview.postMessage(createCommitMessageWebviewMessage(snapshot));
		this.postBusyState();
	}

	private postChangesSnapshot(snapshot: ChangesSnapshot): void {
		void this.view?.webview.postMessage({
			type: 'setChanges',
			state: snapshot.state,
			changes: snapshot.changes,
		});
	}

	private postBusyState(): void {
		void this.view?.webview.postMessage({
			type: 'setBusy',
			operationBusy: this.operationBusy,
			generationBusy: this.generationBusy,
		});
	}

	private updateBadge(): void {
		this.view && (this.view.badge = this.count > 0
			? {
				value: this.count,
				tooltip: `${this.count} working tree change${this.count === 1 ? '' : 's'}`,
			}
			: undefined);
	}

	private parseMessage(value: unknown): ChangesViewMessage | undefined {
		if (!value || typeof value !== 'object' || !('type' in value)) {
			return undefined;
		}

		const message = value as { type?: unknown; value?: unknown; path?: unknown };
		switch (message.type) {
			case 'viewReady':
			case 'generateCommitMessage':
			case 'createPatch':
				return { type: message.type };
			case 'commitMessageChanged':
				return typeof message.value === 'string'
					? { type: message.type, value: message.value }
					: undefined;
			case 'openChangedFile':
				return typeof message.path === 'string'
					? { type: message.type, path: message.path }
					: undefined;
			default:
				return undefined;
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'changes-view.css'),
		);
		const sparkleIconUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'sparkles-svgrepo-com.svg'),
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<style nonce="${nonce}">.generate { --sparkle-icon: url("${sparkleIconUri}"); }</style>
	<title>Changes</title>
</head>
<body>
	<div class="changes-view">
		<div class="message-container">
			<textarea id="message" rows="2" aria-label="Commit message" placeholder="Message (Ctrl+Enter to create patch)" disabled></textarea>
			<button id="generate" class="generate" type="button" title="Generate Commit Message with Copilot" aria-label="Generate Commit Message with Copilot" disabled>
				<span class="generate-icon" aria-hidden="true"></span>
			</button>
		</div>
		<button id="create" class="create" type="button" disabled>Create Patch</button>
		<div id="changes" class="changes" aria-live="polite"></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messageInput = document.getElementById('message');
		const generateButton = document.getElementById('generate');
		const generateIcon = generateButton.querySelector('.generate-icon');
		const createButton = document.getElementById('create');
		const changesContainer = document.getElementById('changes');
		let repositoryAvailable = false;
		let operationBusy = false;
		let generationBusy = false;
		let hasChanges = false;

		function updateDisabledState() {
			messageInput.disabled = !repositoryAvailable || operationBusy;
			generateButton.disabled = !repositoryAvailable || operationBusy || generationBusy;
			generateIcon.classList.toggle('is-busy', generationBusy);
			generateButton.setAttribute('aria-busy', generationBusy ? 'true' : 'false');
			createButton.disabled = !repositoryAvailable || operationBusy || !hasChanges;
		}

		function resizeMessageInput() {
			messageInput.style.height = 'auto';
			messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
		}

		function renderChanges(state, changes) {
			changesContainer.replaceChildren();
			hasChanges = state === 'changes' && Array.isArray(changes) && changes.length > 0;
			if (state === 'noRepository') {
				appendEmptyState('Git repository not found', '');
			} else if (!hasChanges) {
				appendEmptyState('Working tree clean', 'No changes to create a patch');
			} else {
				for (const change of changes) {
					if (!change || typeof change.path !== 'string' || typeof change.fileName !== 'string') {
						continue;
					}
					const row = document.createElement(change.openable ? 'button' : 'div');
					row.className = 'change-row';
					row.title = change.originalPath
						? change.originalPath + ' → ' + change.path
						: change.path;
					const fileName = document.createElement('span');
					fileName.className = 'file-name';
					fileName.textContent = change.fileName;
					const parentPath = document.createElement('span');
					parentPath.className = 'parent-path';
					const renameFrom = typeof change.originalPath === 'string'
						? 'from ' + change.originalPath
						: '';
					parentPath.textContent = [change.parentPath, renameFrom].filter(Boolean).join(' · ');
					const status = document.createElement('span');
					status.className = 'change-status status-' + change.statusTheme;
					status.textContent = change.status;
					status.title = change.statusName;
					row.append(fileName, parentPath, status);
					if (change.openable) {
						row.type = 'button';
						row.addEventListener('click', () => {
							vscode.postMessage({ type: 'openChangedFile', path: change.path });
						});
					}
					changesContainer.appendChild(row);
				}
			}
			updateDisabledState();
		}

		function appendEmptyState(title, description) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';
			const heading = document.createElement('div');
			heading.textContent = title;
			empty.appendChild(heading);
			if (description) {
				const detail = document.createElement('div');
				detail.className = 'empty-description';
				detail.textContent = description;
				empty.appendChild(detail);
			}
			changesContainer.appendChild(empty);
		}

		messageInput.addEventListener('input', () => {
			resizeMessageInput();
			vscode.postMessage({ type: 'commitMessageChanged', value: messageInput.value });
		});
		messageInput.addEventListener('keydown', event => {
			if (event.ctrlKey && event.key === 'Enter') {
				event.preventDefault();
				vscode.postMessage({ type: 'createPatch' });
			}
		});
		generateButton.addEventListener('click', () => {
			vscode.postMessage({ type: 'generateCommitMessage' });
		});
		createButton.addEventListener('click', () => {
			vscode.postMessage({ type: 'createPatch' });
		});
		window.addEventListener('message', event => {
			const message = event.data;
			if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
				return;
			}

			switch (message.type) {
				case 'setCommitMessage':
					if (typeof message.value === 'string' && messageInput.value !== message.value) {
						messageInput.value = message.value;
						resizeMessageInput();
					}
					break;
				case 'setBusy':
					operationBusy = message.operationBusy === true;
					generationBusy = message.generationBusy === true;
					updateDisabledState();
					break;
				case 'setRepositoryAvailable':
					repositoryAvailable = message.available === true;
					updateDisabledState();
					break;
				case 'setChanges':
					renderChanges(message.state, message.changes);
					break;
				case 'focusCommitMessage':
					messageInput.focus();
					break;
			}
		});

		resizeMessageInput();
		updateDisabledState();
		vscode.postMessage({ type: 'viewReady' });
	</script>
</body>
</html>`;
	}

	private disposeViewListeners(): void {
		for (const disposable of this.viewDisposables.splice(0)) {
			disposable.dispose();
		}
	}
}
