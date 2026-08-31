import * as vscode from 'vscode';
import { AuditHistory, AuditHistoryService, HistorySummaryState } from './auditHistoryService';

const historyScheme = 'patch-transfer-history';

export class HistoryPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly contents = new Map<string, string>();
	private previewId = 0;

	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly historyService: AuditHistoryService) {}

	provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		return this.contents.get(uri.toString());
	}

	async show(
		history: AuditHistory,
		repositoryName?: string,
		currentState?: HistorySummaryState,
	): Promise<void> {
		this.previewId += 1;
		const uri = vscode.Uri.from({
			scheme: historyScheme,
			path: `/Patch Transfer History${repositoryName ? ` - ${repositoryName}` : ''}.txt`,
			query: `id=${this.previewId}`,
		});
		this.contents.set(
			uri.toString(),
			this.historyService.formatHistoryDocument(history, repositoryName, currentState),
		);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	dispose(): void {
		this.contents.clear();
		this.changeEmitter.dispose();
	}

	static register(provider: HistoryPreviewProvider): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(historyScheme, provider);
	}
}
