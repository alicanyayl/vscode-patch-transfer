import { constants } from 'fs';
import { appendFile, copyFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { EOL } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import { GitService } from './gitService';
import { PatchState, PatchStateService } from './patchStateService';

export type CreatePatchResult =
	| { status: 'noChanges' }
	| { status: 'success'; patchName: string; patchPath: string }
	| { status: 'pushFailed'; patchName: string; patchPath: string; error: string };

export type CopyPatchResult =
	| { status: 'copied'; fileName: string; destinationPath: string; renamed: boolean }
	| { status: 'alreadyExists'; fileName: string; destinationPath: string };

export type ImportPatchResult =
	| { status: 'imported'; patchName: string; patchPath: string; renamed: boolean }
	| { status: 'invalid'; error: string }
	| { status: 'alreadyExists'; patchName: string; patchPath: string };

export type PatchStatus = 'CREATED' | 'READY' | 'APPLIED' | 'CONFLICT' | 'INVALID';

export interface PatchFile {
	name: string;
	path: string;
	timestamp: Date;
	sha256?: string;
	status: PatchStatus;
	error?: string;
}

export interface PatchApplicationPlan {
	patch: PatchFile;
	olderUnappliedPatchName?: string;
}

export type ApplyPatchResult =
	| { status: 'applied'; patchName: string }
	| { status: 'alreadyApplied'; patchName: string }
	| { status: 'created'; patchName: string }
	| { status: 'notReady'; patchName: string; patchStatus: 'CONFLICT' | 'INVALID'; error: string }
	| { status: 'applyFailed'; patchName: string; error: string }
	| { status: 'stateSaveFailed'; patchName: string; error: string };

interface PatchCandidate {
	name: string;
	path: string;
	timestamp: Date;
}

type TransferPatchResult =
	| { status: 'copied'; fileName: string; path: string; renamed: boolean }
	| { status: 'alreadyExists'; fileName: string; path: string };

type PatchDestinationResolution =
	| { status: 'available'; fileName: string; path: string }
	| { status: 'alreadyExists'; fileName: string; path: string };

export class PatchService {
	private readonly stateService: PatchStateService;

	constructor(
		private readonly gitService: GitService,
		stateService?: PatchStateService,
	) {
		this.stateService = stateService ?? new PatchStateService(gitService);
	}

	async ensureRepositorySetup(workspacePath: string): Promise<void> {
		const repositoryPath = await this.gitService.getRepositoryRoot(workspacePath);
		if (repositoryPath) {
			await this.ensureLocalExclude(repositoryPath);
		}
	}

	async copyPatchToDirectory(
		patchPath: string,
		destinationDirectory: string,
	): Promise<CopyPatchResult> {
		const sourceSha256 = await this.stateService.calculatePatchSha256(patchPath);
		const result = await this.transferPatchFile(
			patchPath,
			destinationDirectory,
			basename(patchPath),
			sourceSha256,
		);
		if (result.status === 'alreadyExists') {
			return {
				status: 'alreadyExists',
				fileName: result.fileName,
				destinationPath: result.path,
			};
		}

		return {
			status: 'copied',
			fileName: result.fileName,
			destinationPath: result.path,
			renamed: result.renamed,
		};
	}

	async importPatch(workspacePath: string, externalPatchPath: string): Promise<ImportPatchResult> {
		const repositoryPath = await this.gitService.getRepositoryRoot(workspacePath);
		if (!repositoryPath) {
			throw new Error('Git repository not found');
		}

		if (extname(externalPatchPath).toLowerCase() !== '.patch') {
			return { status: 'invalid', error: 'Selected file does not have a .patch extension.' };
		}

		try {
			await this.gitService.validatePatch(repositoryPath, externalPatchPath);
		} catch (error) {
			return { status: 'invalid', error: this.getErrorMessage(error) };
		}

		const sourceSha256 = await this.stateService.calculatePatchSha256(externalPatchPath);
		await this.ensureLocalExclude(repositoryPath);
		const patchDirectory = join(repositoryPath, '.patch-transfer');
		await mkdir(patchDirectory, { recursive: true });
		const result = await this.transferPatchFile(
			externalPatchPath,
			patchDirectory,
			basename(externalPatchPath),
			sourceSha256,
		);
		if (result.status === 'alreadyExists') {
			return {
				status: 'alreadyExists',
				patchName: result.fileName,
				patchPath: result.path,
			};
		}

		return {
			status: 'imported',
			patchName: result.fileName,
			patchPath: result.path,
			renamed: result.renamed,
		};
	}

	async createPatch(workspacePath: string, commitMessage: string): Promise<CreatePatchResult> {
		const normalizedCommitMessage = commitMessage.trim();
		if (!normalizedCommitMessage) {
			throw new Error('Enter a commit message before creating the patch.');
		}

		const repositoryPath = await this.gitService.getRepositoryRoot(workspacePath);
		if (!repositoryPath) {
			throw new Error('Git repository not found');
		}

		if (!(await this.gitService.hasChanges(repositoryPath))) {
			return { status: 'noChanges' };
		}

		const patchDirectory = join(repositoryPath, '.patch-transfer');
		await mkdir(patchDirectory, { recursive: true });
		await this.ensureLocalExclude(repositoryPath);

		if (!(await this.gitService.hasChanges(repositoryPath))) {
			return { status: 'noChanges' };
		}

		const timestamp = this.createTimestamp(new Date());
		const patchName = `${timestamp.file}.patch`;
		const patchPath = join(patchDirectory, patchName);

		await this.gitService.stageAllChanges(repositoryPath);
		if (!(await this.gitService.hasStagedChanges(repositoryPath))) {
			return { status: 'noChanges' };
		}

		try {
			await this.gitService.createPatch(repositoryPath, patchPath);
		} catch (error) {
			throw new Error(`Patch creation failed: ${this.getErrorMessage(error)}`);
		}

		try {
			await this.gitService.validatePatch(repositoryPath, patchPath);
		} catch (error) {
			throw new Error(`Patch validation failed: ${this.getErrorMessage(error)}`);
		}

		try {
			const sha256 = await this.stateService.calculatePatchSha256(patchPath);
			await this.stateService.recordCreated(repositoryPath, sha256, patchName);
		} catch (error) {
			throw new Error(`Created patch tracking failed: ${this.getErrorMessage(error)}`);
		}

		try {
			await this.gitService.commit(repositoryPath, normalizedCommitMessage);
		} catch (error) {
			throw new Error(`Commit failed: ${this.getErrorMessage(error)}`);
		}

		try {
			await this.gitService.push(repositoryPath);
			return { status: 'success', patchName, patchPath };
		} catch (error) {
			return {
				status: 'pushFailed',
				patchName,
				patchPath,
				error: this.getErrorMessage(error),
			};
		}
	}

	async listPatches(repositoryPath: string): Promise<PatchFile[]> {
		const state = await this.stateService.load(repositoryPath);
		const candidates = await this.readPatchCandidates(repositoryPath);
		const patches = await Promise.all(
			candidates.map(candidate => this.evaluatePatch(repositoryPath, candidate, state)),
		);

		return patches.sort((left, right) => this.compareNewestFirst(left, right));
	}

	async preparePatchApplication(
		repositoryPath: string,
		patchPath: string,
	): Promise<PatchApplicationPlan> {
		const safePatchPath = this.validatePatchPath(repositoryPath, patchPath);
		const state = await this.stateService.load(repositoryPath);
		const candidates = await this.readPatchCandidates(repositoryPath);
		const candidate = candidates.find(item => this.pathsEqual(item.path, safePatchPath));

		if (!candidate) {
			throw new Error(`Patch file not found: ${basename(safePatchPath)}`);
		}

		const patch = await this.evaluatePatch(repositoryPath, candidate, state);
		if (patch.status !== 'READY') {
			return { patch };
		}

		const olderUnappliedPatchName = await this.findOlderUnappliedPatch(
			candidate,
			candidates,
			state,
		);

		return { patch, olderUnappliedPatchName };
	}

	async applyPatch(repositoryPath: string, patchPath: string): Promise<ApplyPatchResult> {
		const safePatchPath = this.validatePatchPath(repositoryPath, patchPath);
		const patchName = basename(safePatchPath);
		let sha256: string;

		try {
			sha256 = await this.stateService.calculatePatchSha256(safePatchPath);
		} catch (error) {
			return {
				status: 'notReady',
				patchName,
				patchStatus: 'INVALID',
				error: `Could not read patch file: ${this.getErrorMessage(error)}`,
			};
		}

		const state = await this.stateService.load(repositoryPath);
		if (state.applied[sha256]) {
			return { status: 'alreadyApplied', patchName };
		}
		if (state.created[sha256]) {
			return { status: 'created', patchName };
		}

		try {
			await this.gitService.validatePatch(repositoryPath, safePatchPath);
		} catch (error) {
			return {
				status: 'notReady',
				patchName,
				patchStatus: 'INVALID',
				error: this.getErrorMessage(error),
			};
		}

		try {
			await this.gitService.checkPatch(repositoryPath, safePatchPath);
		} catch (error) {
			return {
				status: 'notReady',
				patchName,
				patchStatus: 'CONFLICT',
				error: this.getErrorMessage(error),
			};
		}

		try {
			await this.gitService.applyPatch(repositoryPath, safePatchPath);
		} catch (error) {
			return {
				status: 'applyFailed',
				patchName,
				error: this.getErrorMessage(error),
			};
		}

		try {
			await this.stateService.recordApplied(repositoryPath, sha256, patchName);
			return { status: 'applied', patchName };
		} catch (error) {
			return {
				status: 'stateSaveFailed',
				patchName,
				error: this.getErrorMessage(error),
			};
		}
	}

	private async ensureLocalExclude(repositoryPath: string): Promise<void> {
		const excludePath = await this.gitService.getExcludePath(repositoryPath);
		await mkdir(dirname(excludePath), { recursive: true });

		let content = '';
		try {
			content = await readFile(excludePath, 'utf8');
		} catch (error) {
			const fileError = error as NodeJS.ErrnoException;
			if (fileError.code !== 'ENOENT') {
				throw error;
			}
		}

		if (content.split(/\r?\n/).some(line => line.trim() === '.patch-transfer/')) {
			return;
		}

		const lineBreak = content.includes('\r\n') ? '\r\n' : EOL;
		const prefix = content.length === 0 || /\r?\n$/.test(content) ? '' : lineBreak;
		await appendFile(excludePath, `${prefix}.patch-transfer/${lineBreak}`, 'utf8');
	}

	private async transferPatchFile(
		sourcePath: string,
		destinationDirectory: string,
		preferredFileName: string,
		sourceSha256: string,
	): Promise<TransferPatchResult> {
		const safePreferredFileName = basename(preferredFileName);

		for (;;) {
			const destination = await this.resolveSafePatchDestination(
				destinationDirectory,
				safePreferredFileName,
				sourceSha256,
			);
			if (destination.status === 'alreadyExists') {
				return destination;
			}

			try {
				await copyFile(sourcePath, destination.path, constants.COPYFILE_EXCL);
				return {
					status: 'copied',
					fileName: destination.fileName,
					path: destination.path,
					renamed: !this.fileNamesEqual(destination.fileName, safePreferredFileName),
				};
			} catch (error) {
				if (!this.isAlreadyExistsError(error)) {
					throw error;
				}
			}
		}
	}

	private async resolveSafePatchDestination(
		destinationDirectory: string,
		preferredFileName: string,
		sourceSha256: string,
	): Promise<PatchDestinationResolution> {
		const entries = await readdir(destinationDirectory, { withFileTypes: true });
		const existingPatches = await Promise.all(
			entries
				.filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.patch')
				.map(async entry => ({
					fileName: entry.name,
					path: join(destinationDirectory, entry.name),
					sha256: await this.stateService.calculatePatchSha256(
						join(destinationDirectory, entry.name),
					),
				})),
		);
		const duplicate = existingPatches.find(patch => patch.sha256 === sourceSha256);
		if (duplicate) {
			return {
				status: 'alreadyExists',
				fileName: duplicate.fileName,
				path: duplicate.path,
			};
		}

		const isOccupied = (fileName: string): boolean =>
			entries.some(entry => this.fileNamesEqual(entry.name, fileName));
		if (!isOccupied(preferredFileName)) {
			return {
				status: 'available',
				fileName: preferredFileName,
				path: join(destinationDirectory, preferredFileName),
			};
		}

		const extension = extname(preferredFileName);
		const stem = preferredFileName.slice(0, -extension.length);
		const shaStem = `${stem}_${sourceSha256.slice(0, 8)}`;
		let suffix = 1;
		for (;;) {
			const fileName = `${shaStem}${suffix === 1 ? '' : `_${suffix}`}${extension}`;
			if (!isOccupied(fileName)) {
				return {
					status: 'available',
					fileName,
					path: join(destinationDirectory, fileName),
				};
			}
			suffix += 1;
		}
	}

	private async readPatchCandidates(repositoryPath: string): Promise<PatchCandidate[]> {
		const patchDirectory = join(repositoryPath, '.patch-transfer');

		try {
			const entries = await readdir(patchDirectory, { withFileTypes: true });
			const patchEntries = entries.filter(
				entry => entry.isFile() && extname(entry.name).toLowerCase() === '.patch',
			);

			return await Promise.all(
				patchEntries.map(async entry => {
					const patchPath = join(patchDirectory, entry.name);
					let modifiedAt = new Date(0);

					try {
						modifiedAt = (await stat(patchPath)).mtime;
					} catch {
						// Evaluation below reports a useful per-file read error if the file vanished.
					}

					return {
						name: entry.name,
						path: patchPath,
						timestamp: this.parsePatchTimestamp(entry.name) ?? modifiedAt,
					};
				}),
			);
		} catch (error) {
			const fileError = error as NodeJS.ErrnoException;
			if (fileError.code === 'ENOENT') {
				return [];
			}

			throw error;
		}
	}

	private async evaluatePatch(
		repositoryPath: string,
		candidate: PatchCandidate,
		state: PatchState,
	): Promise<PatchFile> {
		let sha256: string;

		try {
			sha256 = await this.stateService.calculatePatchSha256(candidate.path);
		} catch (error) {
			return {
				...candidate,
				status: 'INVALID',
				error: `Could not read patch file: ${this.getErrorMessage(error)}`,
			};
		}

		if (state.applied[sha256]) {
			return { ...candidate, sha256, status: 'APPLIED' };
		}
		if (state.created[sha256]) {
			return { ...candidate, sha256, status: 'CREATED' };
		}

		try {
			await this.gitService.validatePatch(repositoryPath, candidate.path);
		} catch (error) {
			return {
				...candidate,
				sha256,
				status: 'INVALID',
				error: this.getErrorMessage(error),
			};
		}

		try {
			await this.gitService.checkPatch(repositoryPath, candidate.path);
			return { ...candidate, sha256, status: 'READY' };
		} catch (error) {
			return {
				...candidate,
				sha256,
				status: 'CONFLICT',
				error: this.getErrorMessage(error),
			};
		}
	}

	private async findOlderUnappliedPatch(
		target: PatchCandidate,
		candidates: PatchCandidate[],
		state: PatchState,
	): Promise<string | undefined> {
		const olderCandidates = candidates
			.filter(candidate => this.compareOldestFirst(candidate, target) < 0)
			.sort((left, right) => this.compareOldestFirst(left, right));

		for (const candidate of olderCandidates) {
			try {
				const sha256 = await this.stateService.calculatePatchSha256(candidate.path);
				if (!state.applied[sha256] && !state.created[sha256]) {
					return candidate.name;
				}
			} catch {
				return candidate.name;
			}
		}

		return undefined;
	}

	private validatePatchPath(repositoryPath: string, patchPath: string): string {
		const patchDirectory = resolve(repositoryPath, '.patch-transfer');
		const safePatchPath = resolve(patchPath);

		if (
			!this.pathsEqual(dirname(safePatchPath), patchDirectory) ||
			extname(safePatchPath).toLowerCase() !== '.patch'
		) {
			throw new Error('The selected file is not a repository Patch Transfer patch.');
		}

		return safePatchPath;
	}

	private pathsEqual(left: string, right: string): boolean {
		return process.platform === 'win32'
			? resolve(left).toLowerCase() === resolve(right).toLowerCase()
			: resolve(left) === resolve(right);
	}

	private fileNamesEqual(left: string, right: string): boolean {
		return process.platform === 'win32'
			? left.toLowerCase() === right.toLowerCase()
			: left === right;
	}

	private compareNewestFirst(left: PatchCandidate, right: PatchCandidate): number {
		return -this.compareOldestFirst(left, right);
	}

	private compareOldestFirst(left: PatchCandidate, right: PatchCandidate): number {
		const timestampDifference = left.timestamp.getTime() - right.timestamp.getTime();
		return timestampDifference || left.name.localeCompare(right.name);
	}

	private parsePatchTimestamp(fileName: string): Date | undefined {
		const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.patch$/.exec(
			basename(fileName),
		);
		if (!match) {
			return undefined;
		}

		const [, year, month, day, hours, minutes, seconds] = match;
		const values = [year, month, day, hours, minutes, seconds].map(Number);
		const date = new Date(
			values[0],
			values[1] - 1,
			values[2],
			values[3],
			values[4],
			values[5],
		);

		if (
			date.getFullYear() !== values[0] ||
			date.getMonth() !== values[1] - 1 ||
			date.getDate() !== values[2] ||
			date.getHours() !== values[3] ||
			date.getMinutes() !== values[4] ||
			date.getSeconds() !== values[5]
		) {
			return undefined;
		}

		return date;
	}

	private createTimestamp(date: Date): { file: string } {
		const year = date.getFullYear();
		const month = this.pad(date.getMonth() + 1);
		const day = this.pad(date.getDate());
		const hours = this.pad(date.getHours());
		const minutes = this.pad(date.getMinutes());
		const seconds = this.pad(date.getSeconds());

		return {
			file: `${year}-${month}-${day}_${hours}${minutes}${seconds}`,
		};
	}

	private pad(value: number): string {
		return value.toString().padStart(2, '0');
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private isAlreadyExistsError(error: unknown): boolean {
		return (error as NodeJS.ErrnoException).code === 'EEXIST';
	}
}
