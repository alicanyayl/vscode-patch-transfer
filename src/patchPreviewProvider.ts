import * as vscode from 'vscode';
import { PatchPreview, PatchPreviewChangeType, PatchStatus } from './patchService';

const previewScheme = 'patch-transfer-preview';
const changeTypeOrder: PatchPreviewChangeType[] = ['Modified', 'Added', 'Deleted', 'Renamed'];

export function formatPatchPreview(preview: PatchPreview, status: PatchStatus): string {
	const lines = [
		'Patch Preview',
		preview.patchName,
		'',
		`Status: ${status}`,
	];

	for (const changeType of changeTypeOrder) {
		const files = preview.files.filter(file => file.changeType === changeType);
		if (files.length === 0) {
			continue;
		}

		lines.push('', changeType);
		const labels = files.map(file => file.originalPath
			? `${file.originalPath} → ${file.path}`
			: file.path);
		const labelWidth = Math.min(72, Math.max(...labels.map(label => label.length)));
		for (let index = 0; index < files.length; index += 1) {
			const file = files[index];
			const label = labels[index];
			const statistics = file.additions === undefined && file.deletions === undefined
				? 'binary'
				: `+${file.additions ?? 0}  -${file.deletions ?? 0}`;
			lines.push(`  ${label.padEnd(labelWidth)}  ${statistics}`);
		}
	}

	if (preview.files.length === 0) {
		lines.push('', 'No affected files were reported by Git.');
	}

	return `${lines.join('\n')}\n`;
}

export class PatchPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly contents = new Map<string, string>();
	private previewId = 0;

	readonly onDidChange = this.changeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		return this.contents.get(uri.toString());
	}

	async show(preview: PatchPreview, status: PatchStatus): Promise<void> {
		this.previewId += 1;
		const uri = vscode.Uri.from({
			scheme: previewScheme,
			path: `/Patch Preview - ${preview.patchName}.txt`,
			query: `id=${this.previewId}`,
		});
		this.contents.set(uri.toString(), formatPatchPreview(preview, status));
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	dispose(): void {
		this.contents.clear();
		this.changeEmitter.dispose();
	}

	static register(provider: PatchPreviewProvider): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(previewScheme, provider);
	}
}
