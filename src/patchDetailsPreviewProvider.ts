import * as vscode from 'vscode';
import { PatchMetadata } from './patchMetadataService';
import { PatchStatus } from './patchService';

const patchDetailsScheme = 'patch-transfer-details';

export interface PatchDetailsPresentation {
	patchFileName: string;
	status: PatchStatus;
	sha256?: string;
	metadata?: PatchMetadata;
	hasMissingPredecessor?: boolean;
	missingPredecessorSha?: string;
	stats?: {
		files: number;
		additions?: number;
		deletions?: number;
	};
	affectedPaths?: string[];
}

export function formatPatchDetailsDocument(details: PatchDetailsPresentation): string {
	const lines: string[] = [
		'Patch Details',
		'',
		'File:',
		details.patchFileName,
		'',
		'Status:',
		details.status,
		'',
		'SHA-256:',
		details.sha256 ?? 'Unavailable',
	];

	if (details.metadata) {
		lines.push(
			'',
			'Created:',
			formatTimestamp(details.metadata.createdAt),
			'',
			'Source Commit:',
			details.metadata.source.commitSha ?? 'Unavailable',
			'',
			'Source Branch:',
			details.metadata.source.branch ?? 'Unavailable',
			'',
			'Source Repository:',
			details.metadata.source.repositoryName ?? 'Unavailable',
			'',
			'Previous Patch:',
			details.metadata.chain.previousPatchSha256 ?? 'None (root patch)',
			'',
			'Chain:',
			details.hasMissingPredecessor
				? `Gap: previous patch missing (${details.missingPredecessorSha ?? 'unknown'})`
				: details.metadata.chain.previousPatchSha256
					? 'Complete'
					: 'Root patch (no predecessor)',
		);
	} else {
		lines.push(
			'',
			'Metadata:',
			'Unavailable (legacy patch)',
		);
	}

	const filesCount = details.metadata?.stats?.files ?? details.stats?.files ?? details.affectedPaths?.length ?? 0;
	const additions = details.metadata?.stats?.additions ?? details.stats?.additions;
	const deletions = details.metadata?.stats?.deletions ?? details.stats?.deletions;
	const paths = details.metadata?.paths.length ? details.metadata.paths : (details.affectedPaths ?? []);

	lines.push(
		'',
		'Files:',
		String(filesCount),
	);

	if (additions !== undefined) {
		lines.push(
			'',
			'Additions:',
			String(additions),
		);
	}

	if (deletions !== undefined) {
		lines.push(
			'',
			'Deletions:',
			String(deletions),
		);
	}

	if (paths.length > 0) {
		lines.push(
			'',
			'Affected Paths:',
			...paths.map(p => `- ${p}`),
		);
	}

	return `${lines.join('\n')}\n`;
}

function formatTimestamp(isoString: string): string {
	try {
		const d = new Date(isoString);
		if (!Number.isNaN(d.getTime())) {
			return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
		}
	} catch {
		// Fallback.
	}
	return isoString;
}

export class PatchDetailsPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly contents = new Map<string, string>();
	private previewId = 0;

	readonly onDidChange = this.changeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		return this.contents.get(uri.toString());
	}

	async show(details: PatchDetailsPresentation): Promise<void> {
		this.previewId += 1;
		const uri = vscode.Uri.from({
			scheme: patchDetailsScheme,
			path: `/Patch Details - ${details.patchFileName}.txt`,
			query: `id=${this.previewId}`,
		});
		this.contents.set(uri.toString(), formatPatchDetailsDocument(details));
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	dispose(): void {
		this.contents.clear();
		this.changeEmitter.dispose();
	}

	static register(provider: PatchDetailsPreviewProvider): vscode.Disposable {
		return vscode.workspace.registerTextDocumentContentProvider(patchDetailsScheme, provider);
	}
}
