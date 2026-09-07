import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from './auditHistoryService';
import { GitService } from './gitService';
import { applyHunkReplacement, findSubarrayIndices, matchHunkInTarget } from './patchHunkMatcher';
import { DiffHunk, normalizeLineEndings, parsePatchText } from './patchHunkParser';
import { PatchStateService } from './patchStateService';
import { RollbackService } from './rollbackService';

const execFileAsync = promisify(execFile);

export type HunkResolution = 'unresolved' | 'current' | 'patch' | 'manual';

export interface ResolutionHunk {
	id: string;
	filePath: string;
	hunkIndex: number;
	header: string;
	oldStart?: number;
	oldLines?: number;
	newStart?: number;
	newLines?: number;
	currentText: string;
	patchOldText: string;
	patchNewText: string;
	resolution: HunkResolution;
	canApplyPatchAutomatically: boolean;
	unsafeReason?: string;
	isNewFile?: boolean;
	isDeletedFile?: boolean;
	isRename?: boolean;
	isBinary?: boolean;
	diffHunk?: DiffHunk;
	customResultText?: string;
}

export interface ResolutionFile {
	filePath: string;
	status: 'clean' | 'conflict';
	isNewFile?: boolean;
	isDeletedFile?: boolean;
	isRename?: boolean;
	oldPath?: string;
	newPath?: string;
	isBinary?: boolean;
	hunks: ResolutionHunk[];
	manualResolved?: boolean;
}

export interface ResolutionBaselineEntry {
	exists: boolean;
	sha256?: string;
}

export interface ResolutionSession {
	sessionId: string;
	patchSha: string;
	patchPath: string;
	patchFileName: string;
	sessionDir: string;
	sandboxDir: string;
	resolvedDir: string;
	baseline: Record<string, ResolutionBaselineEntry>;
	affectedPaths: string[];
	files: ResolutionFile[];
	totalChanges?: number;
	cleanChanges?: number;
	createdAt: string;
}


export interface ResolutionReceipt {
	version: 1;
	patchSha: string;
	resolvedAt: string;
	choices: {
		current: number;
		patch: number;
		manual: number;
	};
}

export interface BaselineCheckResult {
	changed: boolean;
	mismatches: string[];
}

export class ConflictResolutionService {
	constructor(
		private readonly gitService: GitService,
		private readonly rollbackService: RollbackService,
		private readonly stateService: PatchStateService,
		private readonly historyService: AuditHistoryService,
	) {}

	async getResolutionReceipt(
		repositoryPath: string,
		patchSha: string,
	): Promise<ResolutionReceipt | undefined> {
		try {
			const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
			const receiptPath = join(
				gitDirectory,
				'patch-transfer',
				'resolutions',
				`${patchSha}.json`,
			);
			const content = await readFile(receiptPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (
				parsed.version === 1 &&
				typeof parsed.patchSha === 'string' &&
				typeof parsed.resolvedAt === 'string' &&
				parsed.choices &&
				typeof parsed.choices === 'object'
			) {
				return parsed as unknown as ResolutionReceipt;
			}
		} catch {
			// Unavailable
		}
		return undefined;
	}

	async cleanupStaleSessions(repositoryPath: string): Promise<void> {
		try {
			const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
			const tempRoot = join(gitDirectory, 'patch-transfer', 'resolution-temp');
			await rm(tempRoot, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}

	async startSession(
		repositoryPath: string,
		patchPath: string,
	): Promise<ResolutionSession> {
		const resolvedRoot = resolve(repositoryPath);
		const safePatchPath = resolve(patchPath);
		const relativeToRoot = relative(resolvedRoot, safePatchPath);
		if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
			throw new Error(
				`Unsafe patch path detected: ${patchPath}. Patch files must reside inside the repository.`,
			);
		}
		const patchFileName = safePatchPath.split(/[\\/]/).pop() ?? 'patch';
		const patchSha = await this.stateService.calculatePatchSha256(safePatchPath);

		// Validate affected paths securely (no path traversal, relative to repo root)
		const affectedPaths = await this.rollbackService.resolveAffectedPaths(
			repositoryPath,
			safePatchPath,
		);

		const sessionId = `session-${Date.now()}-${randomBytes(4).toString('hex')}`;
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		const sessionDir = join(
			gitDirectory,
			'patch-transfer',
			'resolution-temp',
			patchSha,
			sessionId,
		);
		const sandboxDir = join(sessionDir, 'sandbox');
		const resolvedDir = join(sessionDir, 'resolved');

		await mkdir(sandboxDir, { recursive: true });
		await mkdir(resolvedDir, { recursive: true });

		// Capture baseline fingerprints
		const baseline: Record<string, ResolutionBaselineEntry> = {};
		for (const relPath of affectedPaths) {
			const absolutePath = resolve(repositoryPath, relPath);
			try {
				const content = await readFile(absolutePath);
				const sha256 = createHash('sha256').update(content).digest('hex');
				baseline[relPath] = { exists: true, sha256 };

				// Copy existing file to sandbox and resolved initial candidate
				const targetSandbox = join(sandboxDir, relPath);
				const targetResolved = join(resolvedDir, relPath);
				await mkdir(dirname(targetSandbox), { recursive: true });
				await mkdir(dirname(targetResolved), { recursive: true });
				await copyFile(absolutePath, targetSandbox);
				await copyFile(absolutePath, targetResolved);
			} catch {
				baseline[relPath] = { exists: false };
			}
		}

		// Initialize an isolated git repository in sandbox so git apply can run in a work tree
		try {
			await execFileAsync('git', ['init', '-q'], {
				cwd: sandboxDir,
				windowsHide: true,
			});
			await execFileAsync('git', ['config', 'user.name', 'PT Sandbox'], {
				cwd: sandboxDir,
				windowsHide: true,
			});
			await execFileAsync('git', ['config', 'user.email', 'sandbox@example.invalid'], {
				cwd: sandboxDir,
				windowsHide: true,
			});
			await execFileAsync('git', ['add', '-A'], {
				cwd: sandboxDir,
				windowsHide: true,
			});
			await execFileAsync('git', ['commit', '-qm', 'baseline'], {
				cwd: sandboxDir,
				windowsHide: true,
			});
		} catch {
			// Best-effort git init
		}

		// Run git apply --reject in the sandbox
		try {
			await execFileAsync(
				'git',
				['apply', '--reject', '--whitespace=nowarn', safePatchPath],
				{
					cwd: sandboxDir,
					windowsHide: true,
				},
			);
		} catch {
			// Non-zero exit code is normal when rejected hunks exist
		}

		// Copy sandbox files (which contain all clean hunks!) to resolved candidate dir
		await this.copySandboxOutputsToResolved(sandboxDir, resolvedDir);

		// Parse the original patch to know all files and hunks
		const patchContent = await readFile(safePatchPath, 'utf8');
		const parsedPatchFiles = parsePatchText(patchContent);

		// Locate any .rej files inside the sandbox
		const rejMap = await this.findRejFiles(sandboxDir);

		// Build structured ResolutionFile and ResolutionHunk models
		const resolutionFiles: ResolutionFile[] = [];

		for (const parsedFile of parsedPatchFiles) {
			const relPath = parsedFile.displayPath;

			// Handle binary conflict
			if (parsedFile.isBinary) {
				const binaryHunk: ResolutionHunk = {
					id: `${relPath}#binary`,
					filePath: relPath,
					hunkIndex: 0,
					header: 'Binary conflict',
					currentText: '(binary content)',
					patchOldText: '(binary content)',
					patchNewText: '(binary content)',
					resolution: 'unresolved',
					canApplyPatchAutomatically: false,
					unsafeReason: 'Binary conflict cannot be merged automatically; manual resolution required.',
					isBinary: true,
				};

				resolutionFiles.push({
					filePath: relPath,
					status: 'conflict',
					isBinary: true,
					hunks: [binaryHunk],
				});
				continue;
			}

			// Handle new file already exists conflict
			if (parsedFile.isNewFile && baseline[relPath]?.exists) {
				const currentText = await readFile(resolve(repositoryPath, relPath), 'utf8').catch(() => '');
				const incomingText = parsedFile.hunks.length > 0 ? parsedFile.hunks[0].patchNewText : '';

				const newFileHunk: ResolutionHunk = {
					id: `${relPath}#new-file-exists`,
					filePath: relPath,
					hunkIndex: 0,
					header: 'New file conflict',
					currentText,
					patchOldText: '',
					patchNewText: incomingText,
					resolution: 'unresolved',
					canApplyPatchAutomatically: true,
					isNewFile: true,
				};

				resolutionFiles.push({
					filePath: relPath,
					status: 'conflict',
					isNewFile: true,
					hunks: [newFileHunk],
				});
				continue;
			}

			// Handle delete conflict where file still exists and either has rejects or content differs from what patch expected
			if (parsedFile.isDeletedFile && baseline[relPath]?.exists) {
				const currentText = await readFile(resolve(repositoryPath, relPath), 'utf8').catch(() => '');
				const expectedOldText = parsedFile.hunks.map(h => h.patchOldText).join('\n');
				const hasReject = rejMap.has(relPath);
				const contentDiffers =
					normalizeLineEndings(currentText).trim() !== normalizeLineEndings(expectedOldText).trim();

				if (hasReject || contentDiffers) {
					const deleteHunk: ResolutionHunk = {
						id: `${relPath}#delete-conflict`,
						filePath: relPath,
						hunkIndex: 0,
						header: 'Delete conflict',
						currentText,
						patchOldText: expectedOldText,
						patchNewText: '',
						resolution: 'unresolved',
						canApplyPatchAutomatically: true,
						isDeletedFile: true,
					};

					resolutionFiles.push({
						filePath: relPath,
						status: 'conflict',
						isDeletedFile: true,
						hunks: [deleteHunk],
					});
					continue;
				}
			}

			// Handle clean files (no rejects from git apply --reject)
			const rejContent = this.getRejContent(rejMap, relPath);
			if (!rejContent) {
				resolutionFiles.push({
					filePath: relPath,
					status: 'clean',
					isNewFile: parsedFile.isNewFile,
					isDeletedFile: parsedFile.isDeletedFile,
					isRename: parsedFile.isRename,
					oldPath: parsedFile.oldPath,
					newPath: parsedFile.newPath,
					isBinary: false,
					hunks: [],
				});
				continue;
			}

			// Handle rejected hunks from .rej file
			const targetFileContent = baseline[relPath]?.exists
				? await readFile(resolve(repositoryPath, relPath), 'utf8').catch(() => '')
				: '';

			const rejectedFiles = parsePatchText(rejContent);
			const rejectedHunks = rejectedFiles.flatMap(f => f.hunks);

			if (rejectedHunks.length === 0) {
				resolutionFiles.push({
					filePath: relPath,
					status: 'clean',
					isNewFile: parsedFile.isNewFile,
					isDeletedFile: parsedFile.isDeletedFile,
					isRename: parsedFile.isRename,
					oldPath: parsedFile.oldPath,
					newPath: parsedFile.newPath,
					isBinary: false,
					hunks: [],
				});
				continue;
			}

			const sandboxFileContent = await readFile(join(sandboxDir, relPath), 'utf8').catch(() => targetFileContent);
			const fileHunks: ResolutionHunk[] = [];

			for (let idx = 0; idx < rejectedHunks.length; idx++) {
				const hunk = rejectedHunks[idx];
				let match = matchHunkInTarget(sandboxFileContent, hunk);
				if (!match.safe) {
					const targetMatch = matchHunkInTarget(targetFileContent, hunk);
					if (targetMatch.safe) {
						match = targetMatch;
					}
				}

				fileHunks.push({
					id: `${relPath}#hunk-${idx}`,
					filePath: relPath,
					hunkIndex: idx,
					header: hunk.header,
					oldStart: hunk.oldStart,
					oldLines: hunk.oldLines,
					newStart: hunk.newStart,
					newLines: hunk.newLines,
					currentText: match.currentText || hunk.patchOldText,
					patchOldText: hunk.patchOldText,
					patchNewText: hunk.patchNewText,
					resolution: 'unresolved',
					canApplyPatchAutomatically: match.safe,
					unsafeReason: match.unsafeReason,
					diffHunk: hunk,
				});
			}

			resolutionFiles.push({
				filePath: relPath,
				status: 'conflict',
				isRename: parsedFile.isRename,
				oldPath: parsedFile.oldPath,
				newPath: parsedFile.newPath,
				hunks: fileHunks,
			});
		}

		let totalChanges = 0;
		for (const parsedFile of parsedPatchFiles) {
			totalChanges += parsedFile.hunks.length > 0 ? parsedFile.hunks.length : 1;
		}
		let totalConflicts = 0;
		for (const f of resolutionFiles) {
			totalConflicts += f.hunks.length;
		}
		const cleanChanges = Math.max(0, totalChanges - totalConflicts);

		return {
			sessionId,
			patchSha,
			patchPath: safePatchPath,
			patchFileName,
			sessionDir,
			sandboxDir,
			resolvedDir,
			baseline,
			affectedPaths,
			files: resolutionFiles,
			totalChanges,
			cleanChanges,
			createdAt: new Date().toISOString(),
		};
	}


	async checkBaseline(
		session: ResolutionSession,
		repositoryPath: string,
	): Promise<BaselineCheckResult> {
		const mismatches: string[] = [];

		for (const relPath of session.affectedPaths) {
			const entry = session.baseline[relPath];
			const absolutePath = resolve(repositoryPath, relPath);

			let exists = false;
			let currentSha: string | undefined;

			try {
				const content = await readFile(absolutePath);
				exists = true;
				currentSha = createHash('sha256').update(content).digest('hex');
			} catch {
				exists = false;
			}

			if (entry.exists !== exists || entry.sha256 !== currentSha) {
				mismatches.push(relPath);
			}
		}

		return {
			changed: mismatches.length > 0,
			mismatches,
		};
	}

	async setHunkResolution(
		session: ResolutionSession,
		hunkId: string,
		resolution: HunkResolution,
		customText?: string,
	): Promise<void> {
		for (const file of session.files) {
			const hunk = file.hunks.find(h => h.id === hunkId);
			if (!hunk) {
				continue;
			}

			if (resolution === 'patch' && !hunk.canApplyPatchAutomatically) {
				throw new Error(
					hunk.unsafeReason || 'Cannot automatically apply patch change for this conflict.',
				);
			}

			hunk.resolution = resolution;
			if (resolution === 'manual') {
				if (customText !== undefined) {
					hunk.customResultText = customText;
				} else if (hunk.customResultText === undefined) {
					const candidatePath = join(session.resolvedDir, file.filePath);
					try {
						const savedCandidate = await readFile(candidatePath, 'utf8');
						if (file.hunks.length === 1) {
							hunk.customResultText = savedCandidate;
						}
					} catch {
						// Best-effort
					}
				}
			} else if (resolution === 'current') {
				hunk.customResultText = hunk.currentText;
			} else if (resolution === 'patch') {
				hunk.customResultText = hunk.patchNewText;
			}

			// Update resolved candidate file
			await this.recalculateResolvedFile(session, file);
			return;
		}

		throw new Error(`Conflict hunk not found: ${hunkId}`);
	}


	async setFileResolution(
		session: ResolutionSession,
		filePath: string,
		choice: 'current' | 'patch-safe',
	): Promise<void> {
		const file = session.files.find(f => f.filePath === filePath);
		if (!file) {
			throw new Error(`File not found in resolution session: ${filePath}`);
		}

		for (const hunk of file.hunks) {
			if (choice === 'current') {
				hunk.resolution = 'current';
			} else if (choice === 'patch-safe') {
				if (hunk.canApplyPatchAutomatically) {
					hunk.resolution = 'patch';
				}
			}
		}

		await this.recalculateResolvedFile(session, file);
	}

	async markFileManualResolved(
		session: ResolutionSession,
		filePath: string,
	): Promise<void> {
		const file = session.files.find(f => f.filePath === filePath);
		if (!file) {
			throw new Error(`File not found in resolution session: ${filePath}`);
		}

		file.manualResolved = true;
		for (const hunk of file.hunks) {
			hunk.resolution = 'manual';
		}
	}

	async applyResolved(
		session: ResolutionSession,
		repositoryPath: string,
	): Promise<void> {
		// 1. Race condition check
		const baselineCheck = await this.checkBaseline(session, repositoryPath);
		if (baselineCheck.changed) {
			throw new Error('The project changed while this conflict was being resolved.');
		}

		// 2. Validate all conflicts resolved
		for (const file of session.files) {
			for (const hunk of file.hunks) {
				if (hunk.resolution === 'unresolved') {
					throw new Error(
						`Cannot apply resolved patch: conflict in ${file.filePath} is still unresolved.`,
					);
				}
			}
		}

		// 3. Create pre-apply rollback snapshot of all affected paths
		let tempSnapshotDirectory: string | undefined;
		try {
			tempSnapshotDirectory = await this.rollbackService.createSnapshot(
				repositoryPath,
				session.patchSha,
				session.patchFileName,
				session.affectedPaths,
			);
		} catch (error) {
			throw new Error(
				`Rollback snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		let snapshotFinalized = false;
		// 4. Transactionally copy resolved candidate files to real project
		try {
			for (const relPath of session.affectedPaths) {
				const resolvedCandidatePath = join(session.resolvedDir, relPath);
				const targetPath = resolve(repositoryPath, relPath);

				// Check if candidate file exists
				let candidateExists = false;
				try {
					await stat(resolvedCandidatePath);
					candidateExists = true;
				} catch {
					candidateExists = false;
				}

				if (candidateExists) {
					await mkdir(dirname(targetPath), { recursive: true });
					await copyFile(resolvedCandidatePath, targetPath);
				} else {
					// If candidate doesn't exist (e.g. deleted file), remove from real project
					try {
						await unlink(targetPath);
					} catch (err) {
						const fileError = err as NodeJS.ErrnoException;
						if (fileError.code !== 'ENOENT') {
							throw err;
						}
					}
				}
			}
		} catch (writeError) {
			if (tempSnapshotDirectory) {
				try {
					await this.rollbackService.restoreFromSnapshotDirectory(
						repositoryPath,
						tempSnapshotDirectory,
					);
					await this.rollbackService.cleanupTempSnapshot(tempSnapshotDirectory);
				} catch {
					// Preserve temp snapshot if restoration fails
				}
			}
			throw new Error(
				`Failed to apply resolved files: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
			);
		}

		// 5. Finalize rollback snapshot
		try {
			await this.rollbackService.finalizeSnapshot(
				repositoryPath,
				session.patchSha,
				tempSnapshotDirectory,
			);
			snapshotFinalized = true;
		} catch (error) {
			if (tempSnapshotDirectory) {
				try {
					await this.rollbackService.restoreFromSnapshotDirectory(
						repositoryPath,
						tempSnapshotDirectory,
					);
					await this.rollbackService.cleanupTempSnapshot(tempSnapshotDirectory);
				} catch {
					// Preserve temp snapshot if restoration fails
				}
			}
			throw new Error(
				`Rollback finalization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// 6. Write resolution receipt
		let countCurrent = 0;
		let countPatch = 0;
		let countManual = 0;

		for (const file of session.files) {
			for (const hunk of file.hunks) {
				if (hunk.resolution === 'current') {
					countCurrent++;
				} else if (hunk.resolution === 'patch') {
					countPatch++;
				} else if (hunk.resolution === 'manual') {
					countManual++;
				}
			}
		}

		const receipt: ResolutionReceipt = {
			version: 1,
			patchSha: session.patchSha,
			resolvedAt: new Date().toISOString(),
			choices: {
				current: countCurrent,
				patch: countPatch,
				manual: countManual,
			},
		};

		try {
			const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
			const receiptDir = join(gitDirectory, 'patch-transfer', 'resolutions');
			await mkdir(receiptDir, { recursive: true });
			await writeFile(
				join(receiptDir, `${session.patchSha}.json`),
				JSON.stringify(receipt, null, 2),
				'utf8',
			);
		} catch {
			// Best-effort receipt writing
		}

		// 7. Save applied state
		try {
			await this.stateService.recordApplied(
				repositoryPath,
				session.patchSha,
				session.patchFileName,
			);
		} catch (stateError) {
			if (snapshotFinalized) {
				try {
					await this.rollbackService.restoreSnapshot(repositoryPath, session.patchSha);
					await this.rollbackService.deleteSnapshot(repositoryPath, session.patchSha);
				} catch {
					// Preserve snapshot if restoration fails
				}
			}
			throw new Error(
				`Failed to record applied state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
			);
		}

		// 8. Record audit event with resolution summary
		await this.historyService.recordEvent(repositoryPath, {
			timestamp: new Date().toISOString(),
			event: 'APPLIED',
			patchSha256: session.patchSha,
			patchFileName: session.patchFileName,
			filesCount: session.affectedPaths.length,
			resolution: receipt.choices,
		});

		// 9. Clean up temporary session directory
		await this.cancelSession(session);
	}

	async cancelSession(session: ResolutionSession): Promise<void> {
		try {
			await rm(session.sessionDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}

	private async recalculateResolvedFile(
		session: ResolutionSession,
		file: ResolutionFile,
	): Promise<void> {
		// If manually resolved at whole file level without per-hunk text, do not overwrite.
		if (file.manualResolved && !file.hunks.some(h => h.customResultText !== undefined)) {
			return;
		}

		const relPath = file.filePath;
		const candidatePath = join(session.resolvedDir, relPath);
		const initialSandboxPath = join(session.sandboxDir, relPath);

		// Handle binary conflict
		if (file.isBinary) {
			const hunk = file.hunks[0];
			if (hunk.resolution === 'current') {
				// Copy from the original repository file (not sandbox, which may
				// have been modified by git apply --reject).
				await mkdir(dirname(candidatePath), { recursive: true });
				if (session.baseline[relPath]?.exists) {
					await copyFile(initialSandboxPath, candidatePath);
				}
			}
			return;
		}

		// Handle whole-file new file conflict
		if (file.isNewFile) {
			const hunk = file.hunks[0];
			if (hunk.resolution === 'patch' || hunk.resolution === 'manual') {
				await mkdir(dirname(candidatePath), { recursive: true });
				const raw = hunk.customResultText ?? (hunk.resolution === 'patch' ? hunk.patchNewText : hunk.currentText);
				const text =
					raw.length > 0 && !raw.endsWith('\n')
						? raw + '\n'
						: raw;
				await writeFile(candidatePath, text, 'utf8');
			} else {
				// Keep current: the baseline copy was made before git apply ran,
				// so initialSandboxPath still holds the pre-apply content.
				await mkdir(dirname(candidatePath), { recursive: true });
				if (session.baseline[relPath]?.exists) {
					await copyFile(initialSandboxPath, candidatePath);
				}
			}
			return;
		}

		// Handle whole-file delete conflict
		if (file.isDeletedFile) {
			const hunk = file.hunks[0];
			if (hunk.resolution === 'patch') {
				// User confirmed deletion: remove candidate
				await rm(candidatePath, { force: true });
			} else {
				// Keep current: preserve file from baseline
				await mkdir(dirname(candidatePath), { recursive: true });
				if (session.baseline[relPath]?.exists) {
					await copyFile(initialSandboxPath, candidatePath);
				}
			}
			return;
		}

		// Start with the initial sandbox output (which already has clean hunks applied!)
		let currentContent = '';
		try {
			currentContent = await readFile(initialSandboxPath, 'utf8');
		} catch {
			currentContent = '';
		}

		// For each hunk where user selected 'patch' or 'manual', apply it
		for (const hunk of file.hunks) {
			if (hunk.resolution === 'patch' && hunk.diffHunk) {
				const match = matchHunkInTarget(currentContent, hunk.diffHunk);
				if (match.safe) {
					currentContent = applyHunkReplacement(currentContent, match, hunk.diffHunk);
				} else {
					throw new Error(
						`Could not apply resolved conflict hunk ${hunk.hunkIndex + 1} in ${file.filePath}: ` +
						(match.unsafeReason || 'match region not found after applying other hunks'),
					);
				}
			} else if (hunk.resolution === 'manual' && hunk.customResultText !== undefined) {
				const customReplacement = hunk.customResultText;
				let applied = false;
				if (hunk.diffHunk) {
					const customHunk: DiffHunk = {
						...hunk.diffHunk,
						patchNewText: customReplacement,
						addedLines: customReplacement.split(/\r?\n/),
					};
					const match = matchHunkInTarget(currentContent, customHunk);
					if (match.safe) {
						currentContent = applyHunkReplacement(currentContent, match, customHunk);
						applied = true;
					}
				}
				if (!applied) {
					const isCrlf = currentContent.includes('\r\n');
					const targetLines = currentContent.replace(/\r\n/g, '\n').split('\n');
					const currentLines = hunk.currentText.replace(/\r\n/g, '\n').split('\n');
					const replacementLines = customReplacement.replace(/\r\n/g, '\n').split('\n');
					const matchIdx = findSubarrayIndices(targetLines, currentLines);
					if (matchIdx.length === 1) {
						const start = matchIdx[0];
						const end = start + currentLines.length;
						const before = targetLines.slice(0, start);
						const after = targetLines.slice(end);
						const result = [...before, ...replacementLines, ...after];
						currentContent = result.join(isCrlf ? '\r\n' : '\n');
						applied = true;
					}
				}
				if (!applied && file.hunks.length === 1) {
					currentContent = customReplacement;
				}
			}
		}

		await mkdir(dirname(candidatePath), { recursive: true });
		await writeFile(candidatePath, currentContent, 'utf8');
	}


	private async copySandboxOutputsToResolved(
		sandboxDir: string,
		resolvedDir: string,
	): Promise<void> {
		const copyRecursive = async (src: string, dest: string) => {
			const entries = await readdir(src, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name === '.git' || entry.name.endsWith('.rej')) {
					continue;
				}
				const srcPath = join(src, entry.name);
				const destPath = join(dest, entry.name);
				if (entry.isDirectory()) {
					await mkdir(destPath, { recursive: true });
					await copyRecursive(srcPath, destPath);
				} else {
					await mkdir(dirname(destPath), { recursive: true });
					await copyFile(srcPath, destPath);
				}
			}
		};

		await copyRecursive(sandboxDir, resolvedDir);
	}

	private async findRejFiles(directory: string): Promise<Map<string, string>> {
		const rejMap = new Map<string, string>();

		const walk = async (currentDir: string) => {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name === '.git') {
					continue;
				}
				const fullPath = join(currentDir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (entry.name.endsWith('.rej')) {
					const relativeRej = relative(directory, fullPath).replace(/\\/g, '/');
					const relativeOriginal = relativeRej.slice(0, -4);
					const content = await readFile(fullPath, 'utf8');
					rejMap.set(relativeOriginal, content);
				}
			}
		};

		await walk(directory);
		return rejMap;
	}

	private getRejContent(rejMap: Map<string, string>, relPath: string): string | undefined {
		if (rejMap.has(relPath)) {
			return rejMap.get(relPath);
		}
		const normalized = relPath.replace(/\\/g, '/').toLowerCase();
		for (const [key, val] of rejMap.entries()) {
			if (key.replace(/\\/g, '/').toLowerCase() === normalized) {
				return val;
			}
		}
		return undefined;
	}
}
