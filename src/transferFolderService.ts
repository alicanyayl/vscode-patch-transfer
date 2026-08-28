import { resolve } from 'path';
import {
	CopyPatchResult,
	ImportPatchesResult,
	PatchService,
} from './patchService';

const transferFoldersStateKey = 'patchTransfer.transferFolders';

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
	constructor(private readonly workspaceState: TransferFolderMemento) {}

	get(repositoryPath: string): string | undefined {
		return this.readFolders()[this.normalizeRepositoryPath(repositoryPath)];
	}

	async set(repositoryPath: string, folderPath: string): Promise<void> {
		const folders = this.readFolders();
		folders[this.normalizeRepositoryPath(repositoryPath)] = resolve(folderPath);
		await this.workspaceState.update(transferFoldersStateKey, folders);
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

	private readFolders(): Record<string, string> {
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

		return {
			status: 'completed',
			folderPath,
			result: await this.patchService.importPatchesFromDirectory(
				repositoryPath,
				folderPath,
			),
		};
	}
}
