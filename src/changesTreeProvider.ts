import { basename, dirname, join } from 'path';
import * as vscode from 'vscode';
import { GitChange, GitService } from './gitService';

interface ChangeStatus {
	code: string;
	name: string;
	icon: string;
	color: string;
}

class ChangeTreeItem extends vscode.TreeItem {
	constructor(change: GitChange, repositoryPath: string) {
		const status = getChangeStatus(change.status);
		const parentDirectory = dirname(change.path).replace(/\\/g, '/');
		super(basename(change.path), vscode.TreeItemCollapsibleState.None);

		this.description = parentDirectory === '.' ? undefined : parentDirectory;
		this.iconPath = new vscode.ThemeIcon(status.icon, new vscode.ThemeColor(status.color));
		this.resourceUri = vscode.Uri.from({
			scheme: 'patch-transfer-change',
			path: `/${change.path.replace(/\\/g, '/')}`,
			query: status.code,
		});

		const displayPath = change.originalPath
			? `${change.originalPath} -> ${change.path}`
			: change.path;
		this.tooltip = `${displayPath}\nStatus: ${status.code} (${status.name})`;

		if (status.code !== 'D') {
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [vscode.Uri.file(join(repositoryPath, change.path))],
			};
		}
	}
}

class MessageTreeItem extends vscode.TreeItem {
	constructor(message: string, description: string | undefined, icon: vscode.ThemeIcon) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = icon;
	}
}

export class ChangesTreeProvider
	implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.FileDecorationProvider
{
	private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	private items: vscode.TreeItem[] = [];
	private snapshotKey = '';
	private refreshGeneration = 0;
	private changeCount = 0;

	readonly onDidChangeTreeData = this.changeEmitter.event;
	readonly onDidChangeFileDecorations = this.decorationEmitter.event;

	constructor(private readonly gitService: GitService) {}

	get count(): number {
		return this.changeCount;
	}

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const repositoryPath = workspacePath
			? await this.gitService.getRepositoryRoot(workspacePath)
			: undefined;
		const changes = repositoryPath
			? await this.gitService.getChanges(repositoryPath)
			: undefined;
		const state = !repositoryPath || !changes ? 'noRepository' : changes.length === 0 ? 'clean' : 'changes';

		if (generation !== this.refreshGeneration) {
			return;
		}

		const snapshotKey = `${repositoryPath ?? ''}\0${state}\0${changes
			?.map(change => `${change.status}\0${change.path}\0${change.originalPath ?? ''}`)
			.join('\0') ?? ''}`;
		if (snapshotKey === this.snapshotKey) {
			return;
		}

		this.snapshotKey = snapshotKey;
		this.changeCount = changes?.length ?? 0;
		this.items = this.createItems(state, changes ?? [], repositoryPath);
		this.changeEmitter.fire(undefined);
		this.decorationEmitter.fire(undefined);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		return element ? [] : this.items;
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'patch-transfer-change') {
			return undefined;
		}

		const status = getChangeStatus(uri.query);
		return new vscode.FileDecoration(
			status.code,
			status.name,
			new vscode.ThemeColor(status.color),
		);
	}

	private createItems(
		state: string,
		changes: GitChange[],
		repositoryPath: string | undefined,
	): vscode.TreeItem[] {
		if (state === 'noRepository' || !repositoryPath) {
			return [
				new MessageTreeItem(
					'Git repository not found',
					undefined,
					new vscode.ThemeIcon('warning'),
				),
			];
		}

		if (changes.length === 0) {
			return [
				new MessageTreeItem(
					'Working tree clean',
					'No changes to create a patch',
					new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')),
				),
			];
		}

		return changes.map(change => new ChangeTreeItem(change, repositoryPath));
	}
}

function getChangeStatus(gitStatus: string): ChangeStatus {
	if (gitStatus === '??' || gitStatus.includes('U')) {
		return {
			code: 'U',
			name: gitStatus === '??' ? 'Untracked' : 'Unmerged',
			icon: 'new-file',
			color: 'gitDecoration.untrackedResourceForeground',
		};
	}

	if (gitStatus.includes('R')) {
		return {
			code: 'R',
			name: 'Renamed',
			icon: 'diff-renamed',
			color: 'gitDecoration.renamedResourceForeground',
		};
	}

	if (gitStatus.includes('D')) {
		return {
			code: 'D',
			name: 'Deleted',
			icon: 'diff-removed',
			color: 'gitDecoration.deletedResourceForeground',
		};
	}

	if (gitStatus.includes('A')) {
		return {
			code: 'A',
			name: 'Added',
			icon: 'diff-added',
			color: 'gitDecoration.addedResourceForeground',
		};
	}

	return {
		code: 'M',
		name: 'Modified',
		icon: 'diff-modified',
		color: 'gitDecoration.modifiedResourceForeground',
	};
}
