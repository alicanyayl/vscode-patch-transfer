import { appendFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { EOL } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import { GitService } from './gitService';
import { PatchState, PatchStateService } from './patchStateService';

export type CreatePatchResult =
	| { status: 'noChanges' }
	| { status: 'success'; patchName: string }
	| { status: 'pushFailed'; patchName: string; error: string };

export type PatchStatus = 'READY' | 'APPLIED' | 'CONFLICT' | 'INVALID';

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
	| { status: 'notReady'; patchName: string; patchStatus: 'CONFLICT' | 'INVALID'; error: string }
	| { status: 'applyFailed'; patchName: string; error: string }
	| { status: 'stateSaveFailed'; patchName: string; error: string };

interface PatchCandidate {
	name: string;
	path: string;
	timestamp: Date;
}

export class PatchService {
	private readonly stateService: PatchStateService;

	constructor(
		private readonly gitService: GitService,
		stateService?: PatchStateService,
	) {
		this.stateService = stateService ?? new PatchStateService(gitService);
	}

	async createPatch(workspacePath: string): Promise<CreatePatchResult> {
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
			await this.gitService.commit(repositoryPath, `Patch Transfer: ${timestamp.commit}`);
		} catch (error) {
			throw new Error(`Commit failed: ${this.getErrorMessage(error)}`);
		}

		try {
			await this.gitService.push(repositoryPath);
			return { status: 'success', patchName };
		} catch (error) {
			return { status: 'pushFailed', patchName, error: this.getErrorMessage(error) };
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
				if (!state.applied[sha256]) {
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

	private createTimestamp(date: Date): { file: string; commit: string } {
		const year = date.getFullYear();
		const month = this.pad(date.getMonth() + 1);
		const day = this.pad(date.getDate());
		const hours = this.pad(date.getHours());
		const minutes = this.pad(date.getMinutes());
		const seconds = this.pad(date.getSeconds());

		return {
			file: `${year}-${month}-${day}_${hours}${minutes}${seconds}`,
			commit: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
		};
	}

	private pad(value: number): string {
		return value.toString().padStart(2, '0');
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
