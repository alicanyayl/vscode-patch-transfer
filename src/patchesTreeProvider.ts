import { basename, resolve } from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { PatchFile, PatchService, PatchStatus } from './patchService';
import { PatchStateService } from './patchStateService';
import { RollbackService } from './rollbackService';

interface PatchPresentation {
	description: string;
	icon: vscode.ThemeIcon;
	statusDetail?: string;
}

export class PatchTreeItem extends vscode.TreeItem {
	constructor(readonly patch: PatchFile, undoable = false, gapWarning?: string) {
		super(patch.name, vscode.TreeItemCollapsibleState.None);
		this.id = patch.path;
		this.resourceUri = vscode.Uri.file(patch.path);
		const presentation = getPatchPresentation(patch.status);

		this.description = gapWarning
			? `${presentation.description} ⚠`
			: presentation.description;
		this.iconPath = presentation.icon;
		this.contextValue = undoable
			? 'patchTransfer.patch.applied.undoable'
			: `patchTransfer.patch.${patch.status.toLowerCase()}`;
		this.tooltip = [
			patch.path,
			`Status: ${presentation.description}`,
			presentation.statusDetail,
			gapWarning ? `⚠ ${gapWarning}` : undefined,
			undoable ? 'Undo is available for this patch.' : undefined,
			patch.sha256 ? `SHA-256: ${patch.sha256}` : undefined,
			patch.error ? `Git: ${patch.error}` : undefined,
		].filter((line): line is string => Boolean(line)).join('\n');
		this.command = {
			command: 'vscode.open',
			title: 'Open Patch',
			arguments: [vscode.Uri.file(patch.path)],
		};
	}
}

class MessageTreeItem extends vscode.TreeItem {
	constructor(message: string, description: string | undefined, icon: vscode.ThemeIcon) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = icon;
		this.tooltip = description;
	}
}

export class PatchesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private items: vscode.TreeItem[] = [];
	private patches: PatchFile[] = [];
	private snapshotKey = '';
	private refreshGeneration = 0;
	private patchCount = 0;
	private refreshError: string | undefined;

	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(
		private readonly gitService: GitService,
		private readonly patchService: PatchService,
		private readonly stateService?: PatchStateService,
		private readonly rollbackService?: RollbackService,
	) {}

	private lastRepositoryPath: string | undefined;

	get count(): number {
		return this.patchCount;
	}

	get errorMessage(): string | undefined {
		return this.refreshError;
	}

	getCurrentPatch(patchPath: string): PatchFile | undefined {
		const normalizedPath = this.normalizePath(patchPath);
		return this.patches.find(patch => this.normalizePath(patch.path) === normalizedPath);
	}

	async refresh(targetRepositoryPath?: string): Promise<void> {
		const generation = ++this.refreshGeneration;
		if (targetRepositoryPath) {
			this.lastRepositoryPath = targetRepositoryPath;
		}
		const workspacePath = targetRepositoryPath ?? this.lastRepositoryPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const repositoryContext = workspacePath
			? await this.gitService.getRepositoryContext(workspacePath)
			: { status: 'notRepository' as const };
		const repositoryPath = repositoryContext.status === 'repository'
			? repositoryContext.repositoryPath
			: undefined;

		let patches: PatchFile[] = [];
		let state = repositoryContext.status === 'missingGit' ? 'missingGit' : 'noRepository';
		let refreshError: string | undefined;

		if (repositoryPath) {
			this.lastRepositoryPath = repositoryPath;
			try {
				patches = await this.patchService.listPatches(repositoryPath);
				state = patches.length === 0 ? 'empty' : 'patches';
			} catch (error) {
				state = 'error';
				refreshError = this.getErrorMessage(error);
			}
		}

		if (generation !== this.refreshGeneration) {
			return;
		}

		// Determine the latest applied SHA that has a valid rollback snapshot.
		let latestUndoableSha: string | undefined;
		if (repositoryPath && this.stateService && this.rollbackService) {
			try {
				const latestSha = await this.stateService.getLatestAppliedSha(repositoryPath);
				if (latestSha && await this.rollbackService.hasSnapshot(repositoryPath, latestSha)) {
					latestUndoableSha = latestSha;
				}
			} catch {
				// Best-effort; do not block refresh.
			}
		}

		if (generation !== this.refreshGeneration) {
			return;
		}

		const snapshotKey = [
			repositoryPath ?? '',
			state,
			refreshError ?? '',
			latestUndoableSha ?? '',
			...patches.map(
				patch => `${patch.name}\0${patch.sha256 ?? ''}\0${patch.status}\0${patch.error ?? ''}`,
			),
		].join('\0');
		if (snapshotKey === this.snapshotKey) {
			return;
		}

		this.snapshotKey = snapshotKey;
		this.patches = patches;
		this.patchCount = patches.length;
		this.refreshError = refreshError;
		this.items = this.createItems(state, patches, refreshError, latestUndoableSha);
		this.changeEmitter.fire(undefined);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		return element ? [] : this.items;
	}

	private createItems(
		state: string,
		patches: PatchFile[],
		refreshError?: string,
		latestUndoableSha?: string,
	): vscode.TreeItem[] {
		if (state === 'missingGit') {
			return [
				new MessageTreeItem(
					'Git is required to use Patch Transfer.',
					'Install Git and reload VS Code.',
					new vscode.ThemeIcon('warning'),
				),
			];
		}

		if (state === 'noRepository') {
			return [
				new MessageTreeItem(
					'Open a Git repository to use Patch Transfer.',
					undefined,
					new vscode.ThemeIcon('warning'),
				),
			];
		}

		if (state === 'error' && patches.length === 0) {
			return [
				new MessageTreeItem(
					'Patch state unavailable',
					refreshError,
					new vscode.ThemeIcon(
						'error',
						new vscode.ThemeColor('problemsErrorIcon.foreground'),
					),
				),
			];
		}

		if (patches.length === 0) {
			return [
				new MessageTreeItem(
					'No patches found',
					undefined,
					new vscode.ThemeIcon('archive'),
				),
			];
		}

		return patches.map(patch => {
			const undoable = patch.status === 'APPLIED' &&
				patch.sha256 !== undefined &&
				patch.sha256 === latestUndoableSha;
			return new PatchTreeItem(patch, undoable);
		});
	}

	private normalizePath(filePath: string): string {
		const normalized = resolve(filePath);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

function getPatchPresentation(status: PatchStatus): PatchPresentation {
	switch (status) {
		case 'CREATED':
			return {
				description: 'CREATED',
				icon: new vscode.ThemeIcon(
					'check',
					new vscode.ThemeColor('testing.iconPassed'),
				),
			};
		case 'READY':
			return {
				description: 'READY',
				statusDetail: 'Ready to apply to the current project.',
				icon: new vscode.ThemeIcon('circle-filled'),
			};
		case 'APPLIED':
			return {
				description: 'APPLIED ✓',
				statusDetail: 'This patch has already been applied.',
				icon: new vscode.ThemeIcon(
					'check',
					new vscode.ThemeColor('testing.iconPassed'),
				),
			};
		case 'CONFLICT':
			return {
				description: 'CONFLICT',
				statusDetail: 'This patch cannot currently be applied.\nOpen Conflict Details to see the affected files.',
				icon: new vscode.ThemeIcon(
					'warning',
					new vscode.ThemeColor('problemsWarningIcon.foreground'),
				),
			};
		case 'INVALID':
			return {
				description: 'INVALID',
				icon: new vscode.ThemeIcon(
					'error',
					new vscode.ThemeColor('problemsErrorIcon.foreground'),
				),
			};
	}
}

export function isPatchTreeItem(value: unknown): value is PatchTreeItem {
	if (value instanceof PatchTreeItem) {
		return true;
	}
	if (typeof value === 'object' && value !== null && 'patch' in value) {
		const candidate = (value as { patch: unknown }).patch;
		return (
			typeof candidate === 'object' &&
			candidate !== null &&
			'path' in candidate &&
			typeof (candidate as { path: unknown }).path === 'string'
		);
	}
	return false;
}

export function isPatchFile(value: unknown): value is PatchFile {
	return (
		typeof value === 'object' &&
		value !== null &&
		'path' in value &&
		typeof (value as PatchFile).path === 'string' &&
		'status' in value &&
		typeof (value as PatchFile).status === 'string'
	);
}

function extractCandidate(input: unknown): { path?: string; patch?: PatchFile } | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}
	if (Array.isArray(input)) {
		return input.length > 0 ? extractCandidate(input[0]) : undefined;
	}
	if (isPatchTreeItem(input)) {
		return { path: input.patch.path, patch: input.patch };
	}
	if (isPatchFile(input)) {
		return { path: input.path, patch: input };
	}
	if (typeof input === 'string') {
		return { path: input };
	}
	if (input instanceof vscode.Uri) {
		return { path: input.fsPath };
	}
	if (typeof input === 'object') {
		const obj = input as Record<string, unknown>;
		if (obj.resourceUri instanceof vscode.Uri) {
			return { path: obj.resourceUri.fsPath };
		}
		if (obj.resourceUri && typeof obj.resourceUri === 'object' && 'fsPath' in obj.resourceUri) {
			return { path: (obj.resourceUri as { fsPath: string }).fsPath };
		}
		if (typeof obj.fsPath === 'string') {
			return { path: obj.fsPath };
		}
		if (obj.patch && typeof obj.patch === 'object') {
			return extractCandidate(obj.patch);
		}
		if (typeof obj.path === 'string') {
			return { path: obj.path };
		}
		if (typeof obj.id === 'string' && obj.id.toLowerCase().endsWith('.patch')) {
			return { path: obj.id };
		}
	}
	return undefined;
}

export function resolveTargetPatch(
	argument: unknown,
	selectedItem: unknown,
	currentPatchFinder?: (path: string) => PatchFile | undefined,
): PatchFile | undefined {
	// Priority 1: Explicit TreeItem or command argument passed by VS Code
	const explicitTarget = extractCandidate(argument);
	if (explicitTarget) {
		if (explicitTarget.path) {
			const found = currentPatchFinder?.(explicitTarget.path);
			if (found) {
				return found;
			}
		}
		if (explicitTarget.patch) {
			return explicitTarget.patch;
		}
		if (explicitTarget.path) {
			return {
				name: basename(explicitTarget.path),
				path: explicitTarget.path,
				status: 'READY',
				timestamp: new Date(),
			};
		}
	}

	// Priority 2: Current TreeView selection (or active tracked selection)
	const selectionTarget = extractCandidate(selectedItem);
	if (selectionTarget) {
		if (selectionTarget.path) {
			const found = currentPatchFinder?.(selectionTarget.path);
			if (found) {
				return found;
			}
		}
		if (selectionTarget.patch) {
			return selectionTarget.patch;
		}
		if (selectionTarget.path) {
			return {
				name: basename(selectionTarget.path),
				path: selectionTarget.path,
				status: 'READY',
				timestamp: new Date(),
			};
		}
	}

	// Priority 3: No target found -> returns undefined so caller shows warning
	return undefined;
}
