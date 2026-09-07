import { stat } from 'fs/promises';
import { resolve } from 'path';
import { GitService } from './gitService';
import {
	CopyPatchResult,
	ImportPatchesResult,
	PatchService,
} from './patchService';

const transferFoldersStateKey = 'patchTransfer.transferFolders';
export const gitConfigTransferFolderKey = 'patchTransfer.transferFolder';

export interface TransferFolderMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export type TransferFolderPicker = () => Promise<string | undefined>;

export type CreatedPatchTransferResult =
	| { status: 'cancelled' }
	| ({ folderPath: string } & CopyPatchResult);

export type FolderImportResult =
	| { status: 'cancelled' }
	| { status: 'completed'; folderPath: string; result: ImportPatchesResult };

export class TransferFolderService {
	private readonly gitService: GitService;
	private readonly workspaceState?: TransferFolderMemento;

	constructor(
		gitServiceOrMemento?: GitService | TransferFolderMemento,
		workspaceState?: TransferFolderMemento,
	) {
		if (gitServiceOrMemento && 'getRepositoryContext' in gitServiceOrMemento) {
			this.gitService = gitServiceOrMemento as GitService;
			this.workspaceState = workspaceState;
		} else {
			this.gitService = new GitService();
			this.workspaceState = gitServiceOrMemento as TransferFolderMemento | undefined;
		}
	}

	get(repositoryPath: string): string | undefined {
		// 1. Authoritative: check repository-local Git config
		try {
			const gitValue = this.gitService.getLocalConfigSync(
				repositoryPath,
				gitConfigTransferFolderKey,
			);
			if (gitValue) {
				return resolve(gitValue);
			}
		} catch {
			// Ignore Git lookup errors (e.g. not a Git repo)
		}

		// 2. Backward-compatible check in legacy workspaceState
		const legacyFolders = this.readLegacyFolders();
		const legacyValue = legacyFolders[this.normalizeRepositoryPath(repositoryPath)];
		if (legacyValue) {
			const resolved = resolve(legacyValue);
			// One-way migration into repository-local Git config
			try {
				this.gitService.setLocalConfigSync(
					repositoryPath,
					gitConfigTransferFolderKey,
					resolved,
				);
			} catch {
				// Best-effort migration
			}
			return resolved;
		}

		return undefined;
	}

	async set(repositoryPath: string, folderPath: string): Promise<void> {
		const resolvedFolder = resolve(folderPath);

		// 1. Authoritative: write to repository-local Git config
		try {
			await this.gitService.setLocalConfig(
				repositoryPath,
				gitConfigTransferFolderKey,
				resolvedFolder,
			);
		} catch {
			// Fallback if not a Git repository (e.g. non-git synthetic test environments)
		}

		// 2. Also keep workspaceState updated if available
		if (this.workspaceState) {
			const folders = this.readLegacyFolders();
			folders[this.normalizeRepositoryPath(repositoryPath)] = resolvedFolder;
			await this.workspaceState.update(transferFoldersStateKey, folders);
		}
	}

	async select(repositoryPath: string, picker: TransferFolderPicker): Promise<string | undefined> {
		const folderPath = await picker();
		if (!folderPath) {
			return undefined;
		}

		await this.set(repositoryPath, folderPath);
		return resolve(folderPath);
	}

	async getOrSelect(
		repositoryPath: string,
		picker: TransferFolderPicker,
	): Promise<string | undefined> {
		return this.get(repositoryPath) ?? this.select(repositoryPath, picker);
	}

	private readLegacyFolders(): Record<string, string> {
		if (!this.workspaceState) {
			return {};
		}

		const stored = this.workspaceState.get<unknown>(transferFoldersStateKey);
		if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
			return {};
		}

		return Object.fromEntries(
			Object.entries(stored).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			),
		);
	}

	private normalizeRepositoryPath(repositoryPath: string): string {
		const normalized = resolve(repositoryPath);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}
}

export class TransferWorkflowService {
	constructor(
		private readonly transferFolders: TransferFolderService,
		private readonly patchService: PatchService,
	) {}

	async setTransferFolder(
		repositoryPath: string,
		picker: TransferFolderPicker,
	): Promise<string | undefined> {
		return this.transferFolders.select(repositoryPath, picker);
	}

	async transferCreatedPatch(
		repositoryPath: string,
		patchPath: string,
		picker: TransferFolderPicker,
	): Promise<CreatedPatchTransferResult> {
		const folderPath = await this.transferFolders.getOrSelect(repositoryPath, picker);
		if (!folderPath) {
			return { status: 'cancelled' };
		}

		await this.ensureFolderAvailable(folderPath);

		return {
			folderPath,
			...await this.patchService.copyPatchToDirectory(patchPath, folderPath),
		};
	}

	async importAvailablePatches(
		repositoryPath: string,
		picker: TransferFolderPicker,
	): Promise<FolderImportResult> {
		const folderPath = await this.transferFolders.getOrSelect(repositoryPath, picker);
		if (!folderPath) {
			return { status: 'cancelled' };
		}

		await this.ensureFolderAvailable(folderPath);

		return {
			status: 'completed',
			folderPath,
			result: await this.patchService.importPatchesFromDirectory(
				repositoryPath,
				folderPath,
			),
		};
	}

	private async ensureFolderAvailable(folderPath: string): Promise<void> {
		try {
			const info = await stat(folderPath);
			if (!info.isDirectory()) {
				throw new Error(
					`Transfer folder is currently unavailable:\n${folderPath}\n\nUse "Set Transfer Folder" to change it.`,
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes('Transfer folder is currently unavailable:')) {
				throw error;
			}
			throw new Error(
				`Transfer folder is currently unavailable:\n${folderPath}\n\nUse "Set Transfer Folder" to change it.`,
			);
		}
	}
}
