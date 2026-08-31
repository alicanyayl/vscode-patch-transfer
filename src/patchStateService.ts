import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { GitService } from './gitService';

export interface AppliedPatchRecord {
	fileName: string;
	appliedAt: string;
}

export interface CreatedPatchRecord {
	fileName: string;
	createdAt: string;
}

export interface PatchState {
	version: 1;
	created: Record<string, CreatedPatchRecord>;
	applied: Record<string, AppliedPatchRecord>;
}

export class PatchStateError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PatchStateError';
	}
}

export class PatchStateService {
	constructor(private readonly gitService: GitService) {}

	async calculatePatchSha256(patchPath: string): Promise<string> {
		const contents = await readFile(patchPath);
		return createHash('sha256').update(contents).digest('hex');
	}

	async load(repositoryPath: string): Promise<PatchState> {
		const statePath = await this.getStatePath(repositoryPath);
		let contents: string;

		try {
			contents = await readFile(statePath, 'utf8');
		} catch (error) {
			const fileError = error as NodeJS.ErrnoException;
			if (fileError.code === 'ENOENT') {
				return this.createEmptyState();
			}

			throw new PatchStateError(
				`Could not read Patch Transfer state: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}

		let value: unknown;
		try {
			value = JSON.parse(contents);
		} catch (error) {
			throw new PatchStateError(
				`Patch Transfer state is malformed: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}

		const state = this.normalizePatchState(value);
		if (!state) {
			throw new PatchStateError(
				`Patch Transfer state is malformed: ${statePath}. Expected version 1 state data.`,
			);
		}

		return state;
	}

	async recordCreated(
		repositoryPath: string,
		sha256: string,
		fileName: string,
		createdAt = new Date(),
	): Promise<void> {
		const state = await this.load(repositoryPath);
		state.created[sha256] = {
			fileName,
			createdAt: createdAt.toISOString(),
		};

		await this.write(repositoryPath, state);
	}

	async recordApplied(
		repositoryPath: string,
		sha256: string,
		fileName: string,
		appliedAt = new Date(),
	): Promise<void> {
		const state = await this.load(repositoryPath);
		state.applied[sha256] = {
			fileName,
			appliedAt: appliedAt.toISOString(),
		};

		await this.write(repositoryPath, state);
	}

	async removeApplied(
		repositoryPath: string,
		sha256: string,
	): Promise<void> {
		const state = await this.load(repositoryPath);
		if (!state.applied[sha256]) {
			return;
		}

		delete state.applied[sha256];
		await this.write(repositoryPath, state);
	}

	async getLatestAppliedSha(repositoryPath: string): Promise<string | undefined> {
		const state = await this.load(repositoryPath);
		let latestSha: string | undefined;
		let latestTime = -Infinity;

		for (const [sha256, record] of Object.entries(state.applied)) {
			const time = Date.parse(record.appliedAt);
			if (!Number.isNaN(time) && time > latestTime) {
				latestTime = time;
				latestSha = sha256;
			}
		}

		return latestSha;
	}

	async getLatestCreatedSha(repositoryPath: string): Promise<string | undefined> {
		const state = await this.load(repositoryPath);
		let latestSha: string | undefined;
		let latestTime = -Infinity;

		for (const [sha256, record] of Object.entries(state.created)) {
			const time = Date.parse(record.createdAt);
			if (!Number.isNaN(time) && time > latestTime) {
				latestTime = time;
				latestSha = sha256;
			}
		}

		return latestSha;
	}

	async getStatePath(repositoryPath: string): Promise<string> {
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		return join(gitDirectory, 'patch-transfer', 'state.json');
	}

	private async write(repositoryPath: string, state: PatchState): Promise<void> {
		const statePath = await this.getStatePath(repositoryPath);
		const stateDirectory = dirname(statePath);
		const temporaryPath = join(
			stateDirectory,
			`state.json.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`,
		);

		await mkdir(stateDirectory, { recursive: true });

		try {
			await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, {
				encoding: 'utf8',
				flag: 'wx',
			});
			await rename(temporaryPath, statePath);
		} catch (error) {
			try {
				await unlink(temporaryPath);
			} catch (cleanupError) {
				const fileError = cleanupError as NodeJS.ErrnoException;
				if (fileError.code !== 'ENOENT') {
					// Preserve the original persistence failure below.
				}
			}

			throw new PatchStateError(
				`Could not save Patch Transfer state: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	private createEmptyState(): PatchState {
		return { version: 1, created: {}, applied: {} };
	}

	private normalizePatchState(value: unknown): PatchState | undefined {
		if (!value || typeof value !== 'object') {
			return undefined;
		}

		const candidate = value as { version?: unknown; created?: unknown; applied?: unknown };
		if (
			candidate.version !== 1 ||
			!this.isPatchRecordMap(candidate.applied, 'appliedAt') ||
			(candidate.created !== undefined && !this.isPatchRecordMap(candidate.created, 'createdAt'))
		) {
			return undefined;
		}

		return {
			version: 1,
			created: (candidate.created ?? {}) as Record<string, CreatedPatchRecord>,
			applied: candidate.applied as Record<string, AppliedPatchRecord>,
		};
	}

	private isPatchRecordMap(
		value: unknown,
		timestampProperty: 'appliedAt' | 'createdAt',
	): value is Record<string, AppliedPatchRecord | CreatedPatchRecord> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}

		return Object.entries(value).every(([sha256, record]) => {
			if (!/^[a-f0-9]{64}$/.test(sha256) || !record || typeof record !== 'object') {
				return false;
			}

			const patchRecord = record as Record<string, unknown>;
			return (
				typeof patchRecord.fileName === 'string' &&
				typeof patchRecord[timestampProperty] === 'string' &&
				!Number.isNaN(Date.parse(patchRecord[timestampProperty]))
			);
		});
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
