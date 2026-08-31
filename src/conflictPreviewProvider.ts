import * as vscode from 'vscode';
import { formatConflictDetailsDocument, PatchConflictDiagnostic } from './conflictDiagnostics';

const conflictScheme = 'patch-transfer-conflict';

export class ConflictPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly contents = new Map<string, string>();
	private previewId = 0;

	readonly onDidChange = this.changeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		return this.contents.get(uri.toString());
	}

	async show(diagnostic: PatchConflictDiagnostic): Promise<void> {
		this.previewId += 1;
		const uri = vscode.Uri.from({
			scheme: conflictScheme,
			path: `/Patch Conflict Details - ${diagnostic.patchFileName}.txt`,
			query: `id=${this.previewId}`,
		});
		this.contents.set(uri.toString(), formatConflictDetailsDocument(diagnostic));
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	dispose(): void {
		this.contents.clear();
		this.changeEmitter.dispose();
	}

	static register(provider: ConflictPreviewProvider): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(conflictScheme, provider);
	}
}
