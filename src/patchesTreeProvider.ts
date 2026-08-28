import { resolve } from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { PatchFile, PatchService, PatchStatus } from './patchService';

interface PatchPresentation {
	description: string;
	icon: vscode.ThemeIcon;
}

export class PatchTreeItem extends vscode.TreeItem {
	constructor(readonly patch: PatchFile) {
		super(patch.name, vscode.TreeItemCollapsibleState.None);
		const presentation = getPatchPresentation(patch.status);

		this.description = presentation.description;
		this.iconPath = presentation.icon;
		this.contextValue = `patchTransfer.patch.${patch.status.toLowerCase()}`;
		this.tooltip = [
			patch.path,
			`Status: ${presentation.description}`,
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
	) {}

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

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const repositoryPath = workspacePath
			? await this.gitService.getRepositoryRoot(workspacePath)
			: undefined;

		let patches: PatchFile[] = [];
		let state = 'noRepository';
		let refreshError: string | undefined;

		if (repositoryPath) {
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

		const snapshotKey = [
			repositoryPath ?? '',
			state,
			refreshError ?? '',
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
		this.items = this.createItems(state, patches, refreshError);
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
	): vscode.TreeItem[] {
		if (state === 'noRepository') {
			return [
				new MessageTreeItem(
					'Git repository not found',
					undefined,
					new vscode.ThemeIcon('warning'),
				),
			];
		}

		if (state === 'error') {
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

		return patches.map(patch => new PatchTreeItem(patch));
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
				description: 'Created',
				icon: new vscode.ThemeIcon(
					'check',
					new vscode.ThemeColor('testing.iconPassed'),
				),
			};
		case 'READY':
			return {
				description: 'Ready',
				icon: new vscode.ThemeIcon('circle-filled'),
			};
		case 'APPLIED':
			return {
				description: 'Applied',
				icon: new vscode.ThemeIcon(
					'check',
					new vscode.ThemeColor('testing.iconPassed'),
				),
			};
		case 'CONFLICT':
			return {
				description: 'Conflict',
				icon: new vscode.ThemeIcon(
					'warning',
					new vscode.ThemeColor('problemsWarningIcon.foreground'),
				),
			};
		case 'INVALID':
			return {
				description: 'Invalid patch',
				icon: new vscode.ThemeIcon(
					'error',
					new vscode.ThemeColor('problemsErrorIcon.foreground'),
				),
			};
	}
}
