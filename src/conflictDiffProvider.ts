import * as vscode from 'vscode';

const conflictDiffScheme = 'patch-transfer-conflict-diff';

export class ConflictDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly contents = new Map<string, string>();
	private docCounter = 0;

	readonly onDidChange = this.changeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		return this.contents.get(uri.toString());
	}

	async showDiff(
		filePath: string,
		hunkLabel: string,
		currentText: string,
		incomingText: string,
	): Promise<void> {
		this.docCounter++;
		const leftUri = vscode.Uri.from({
			scheme: conflictDiffScheme,
			path: `/${filePath} - CURRENT (TARGET).txt`,
			query: `id=${this.docCounter}&side=target`,
		});
		const rightUri = vscode.Uri.from({
			scheme: conflictDiffScheme,
			path: `/${filePath} - PATCH (INCOMING).txt`,
			query: `id=${this.docCounter}&side=incoming`,
		});

		this.contents.set(leftUri.toString(), currentText);
		this.contents.set(rightUri.toString(), incomingText);

		const title = `${filePath} [${hunkLabel}] (Current Target ↔ Patch Incoming)`;
		await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
			preview: true,
			preserveFocus: false,
		});
	}

	dispose(): void {
		this.contents.clear();
		this.changeEmitter.dispose();
	}

	static register(provider: ConflictDiffProvider): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(conflictDiffScheme, provider);
	}
}
