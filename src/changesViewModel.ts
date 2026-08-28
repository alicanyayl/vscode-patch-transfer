import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';
import { GitChange, GitService } from './gitService';

export type ChangesViewState = 'noRepository' | 'clean' | 'changes';
export type ChangeStatusCode = 'M' | 'A' | 'D' | 'R' | '?' | 'U';

export interface ChangeRow {
	path: string;
	fileName: string;
	parentPath: string;
	status: ChangeStatusCode;
	statusName: string;
	statusTheme: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicting';
	originalPath?: string;
	openable: boolean;
}

export interface ChangesSnapshot {
	state: ChangesViewState;
	repositoryPath?: string;
	changes: ChangeRow[];
}

export class ChangesViewModel {
	private currentSnapshot: ChangesSnapshot = { state: 'noRepository', changes: [] };
	private snapshotKey = '';
	private refreshGeneration = 0;

	constructor(
		private readonly gitService: GitService,
		private readonly getWorkspacePath: () => string | undefined,
	) {}

	get count(): number {
		return this.currentSnapshot.changes.length;
	}

	get snapshot(): ChangesSnapshot {
		return this.currentSnapshot;
	}

	async refresh(): Promise<boolean> {
		const generation = ++this.refreshGeneration;
		const workspacePath = this.getWorkspacePath();
		const repositoryPath = workspacePath
			? await this.gitService.getRepositoryRoot(workspacePath)
			: undefined;
		const gitChanges = repositoryPath
			? await this.gitService.getChanges(repositoryPath)
			: undefined;
		const state: ChangesViewState = !repositoryPath || !gitChanges
			? 'noRepository'
			: gitChanges.length === 0
				? 'clean'
				: 'changes';

		if (generation !== this.refreshGeneration) {
			return false;
		}

		const snapshotKey = `${repositoryPath ?? ''}\0${state}\0${gitChanges
			?.map(change => `${change.status}\0${change.path}\0${change.originalPath ?? ''}`)
			.join('\0') ?? ''}`;
		if (snapshotKey === this.snapshotKey) {
			return false;
		}

		this.snapshotKey = snapshotKey;
		this.currentSnapshot = {
			state,
			repositoryPath,
			changes: (gitChanges ?? []).map(createChangeRow),
		};
		return true;
	}

	getOpenableFilePath(changePath: string): string | undefined {
		const repositoryPath = this.currentSnapshot.repositoryPath;
		const change = this.currentSnapshot.changes.find(item => item.path === changePath);
		if (!repositoryPath || !change?.openable) {
			return undefined;
		}

		const filePath = resolve(repositoryPath, change.path);
		const relativePath = relative(repositoryPath, filePath);
		if (
			!relativePath ||
			isAbsolute(relativePath) ||
			relativePath === '..' ||
			relativePath.startsWith(`..${sep}`)
		) {
			return undefined;
		}

		return filePath;
	}
}

export function createChangeRow(change: GitChange): ChangeRow {
	const presentation = getChangePresentation(change.status);
	const parentPath = dirname(change.path).replace(/\\/g, '/');

	return {
		path: change.path,
		fileName: basename(change.path),
		parentPath: parentPath === '.' ? '' : parentPath,
		...presentation,
		originalPath: change.originalPath,
		openable: presentation.status !== 'D',
	};
}

function getChangePresentation(gitStatus: string): Pick<
	ChangeRow,
	'status' | 'statusName' | 'statusTheme'
> {
	if (gitStatus === '??') {
		return { status: '?', statusName: 'Untracked', statusTheme: 'untracked' };
	}
	if (gitStatus.includes('U')) {
		return { status: 'U', statusName: 'Unmerged', statusTheme: 'conflicting' };
	}
	if (gitStatus.includes('R')) {
		return { status: 'R', statusName: 'Renamed', statusTheme: 'renamed' };
	}
	if (gitStatus.includes('D')) {
		return { status: 'D', statusName: 'Deleted', statusTheme: 'deleted' };
	}
	if (gitStatus.includes('A')) {
		return { status: 'A', statusName: 'Added', statusTheme: 'added' };
	}
	return { status: 'M', statusName: 'Modified', statusTheme: 'modified' };
}
