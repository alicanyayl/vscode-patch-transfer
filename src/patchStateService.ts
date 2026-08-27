import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { GitService } from './gitService';

export interface AppliedPatchRecord {
	fileName: string;
	appliedAt: string;
}

export interface PatchState {
	version: 1;
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
				`Could not read applied patch state: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}

		let value: unknown;
		try {
			value = JSON.parse(contents);
		} catch (error) {
			throw new PatchStateError(
				`Applied patch state is malformed: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}

		if (!this.isPatchState(value)) {
			throw new PatchStateError(
				`Applied patch state is malformed: ${statePath}. Expected version 1 state data.`,
			);
		}

		return value;
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
				`Could not save applied patch state: ${statePath}. ${this.getErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	private createEmptyState(): PatchState {
		return { version: 1, applied: {} };
	}

	private isPatchState(value: unknown): value is PatchState {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const candidate = value as { version?: unknown; applied?: unknown };
		if (
			candidate.version !== 1 ||
			!candidate.applied ||
			typeof candidate.applied !== 'object' ||
			Array.isArray(candidate.applied)
		) {
			return false;
		}

		return Object.entries(candidate.applied).every(([sha256, record]) => {
			if (!/^[a-f0-9]{64}$/.test(sha256) || !record || typeof record !== 'object') {
				return false;
			}

			const appliedRecord = record as { fileName?: unknown; appliedAt?: unknown };
			return (
				typeof appliedRecord.fileName === 'string' &&
				typeof appliedRecord.appliedAt === 'string' &&
				!Number.isNaN(Date.parse(appliedRecord.appliedAt))
			);
		});
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
