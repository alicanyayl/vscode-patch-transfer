import { createHash, randomBytes } from 'crypto';
import { access, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { GitService } from './gitService';
import { extractAffectedPathsFromOutputs } from './patchStats';

export interface RollbackPathEntry {
	path: string;
	beforeExists: boolean;
	beforeSha256?: string;
	afterExists?: boolean;
	afterSha256?: string;
}

export interface RollbackManifest {
	version: 1;
	patchSha: string;
	patchFileName: string;
	appliedAt: string;
	paths: RollbackPathEntry[];
}

export interface FingerprintMismatch {
	path: string;
	expected: string | undefined;
	actual: string | undefined;
}

export class RollbackService {
	constructor(private readonly gitService: GitService) {}

	async getBackupDirectory(repositoryPath: string, patchSha: string): Promise<string> {
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		return join(gitDirectory, 'patch-transfer', 'backups', patchSha);
	}

	async resolveAffectedPaths(repositoryPath: string, patchPath: string): Promise<string[]> {
		const [numStat, summary] = await Promise.all([
			this.gitService.getPatchNumStat(repositoryPath, patchPath),
			this.gitService.getPatchSummary(repositoryPath, patchPath),
		]);
		const paths = extractAffectedPathsFromOutputs(numStat, summary);
		const resolvedRoot = resolve(repositoryPath);

		for (const relativePath of paths) {
			if (isAbsolute(relativePath)) {
				throw new Error(
					`Unsafe path detected in patch: ${relativePath}. Absolute paths are not allowed.`,
				);
			}

			const segments = relativePath.split(/[\\/]/);
			if (segments.some(segment => segment === '..')) {
				throw new Error(
					`Unsafe path detected in patch: ${relativePath}. Path traversal is not allowed.`,
				);
			}

			const absolutePath = resolve(repositoryPath, relativePath);
			const rel = relative(resolvedRoot, absolutePath);
			if (rel.startsWith('..') || isAbsolute(rel)) {
				throw new Error(
					`Unsafe path detected in patch: ${relativePath}. Path resolves outside the repository root.`,
				);
			}
		}

		return paths;
	}

	async createSnapshot(
		repositoryPath: string,
		patchSha: string,
		patchFileName: string,
		affectedPaths: string[],
	): Promise<string> {
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		const backupsRoot = join(gitDirectory, 'patch-transfer', 'backups');
		const tempDirectory = join(
			backupsRoot,
			`.tmp-${patchSha}-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`,
		);
		const beforeDirectory = join(tempDirectory, 'before');

		await mkdir(beforeDirectory, { recursive: true });

		const pathEntries: RollbackPathEntry[] = [];

		for (const relativePath of affectedPaths) {
			const absolutePath = resolve(repositoryPath, relativePath);
			const exists = await this.fileExists(absolutePath);

			if (exists) {
				const content = await readFile(absolutePath);
				const sha256 = this.computeSha256(content);
				const backupFilePath = join(beforeDirectory, sha256);
				await writeFile(backupFilePath, content);

				pathEntries.push({
					path: relativePath,
					beforeExists: true,
					beforeSha256: sha256,
				});
			} else {
				pathEntries.push({
					path: relativePath,
					beforeExists: false,
				});
			}
		}

		const manifest: RollbackManifest = {
			version: 1,
			patchSha,
			patchFileName,
			appliedAt: new Date().toISOString(),
			paths: pathEntries,
		};

		await this.writeManifest(tempDirectory, manifest);
		return tempDirectory;
	}

	async finalizeSnapshot(
		repositoryPath: string,
		patchSha: string,
		tempDirectory: string,
	): Promise<void> {
		const manifest = await this.readManifest(tempDirectory);

		for (const entry of manifest.paths) {
			const absolutePath = resolve(repositoryPath, entry.path);
			const exists = await this.fileExists(absolutePath);

			if (exists) {
				const content = await readFile(absolutePath);
				entry.afterExists = true;
				entry.afterSha256 = this.computeSha256(content);
			} else {
				entry.afterExists = false;
			}
		}

		await this.writeManifest(tempDirectory, manifest);

		const backupDirectory = await this.getBackupDirectory(repositoryPath, patchSha);
		await mkdir(dirname(backupDirectory), { recursive: true });

		try {
			await rm(backupDirectory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup of stale backup.
		}

		await rename(tempDirectory, backupDirectory);
	}

	async cleanupTempSnapshot(tempDirectory: string): Promise<void> {
		try {
			await rm(tempDirectory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}

	async hasSnapshot(repositoryPath: string, patchSha: string): Promise<boolean> {
		const backupDirectory = await this.getBackupDirectory(repositoryPath, patchSha);
		try {
			const manifestPath = join(backupDirectory, 'manifest.json');
			await access(manifestPath);
			return true;
		} catch {
			return false;
		}
	}

	async checkFingerprints(
		repositoryPath: string,
		patchSha: string,
	): Promise<FingerprintMismatch[]> {
		const backupDirectory = await this.getBackupDirectory(repositoryPath, patchSha);
		const manifest = await this.readManifest(backupDirectory);
		const mismatches: FingerprintMismatch[] = [];

		for (const entry of manifest.paths) {
			const absolutePath = resolve(repositoryPath, entry.path);
			const exists = await this.fileExists(absolutePath);

			if (entry.afterExists && exists) {
				const content = await readFile(absolutePath);
				const currentSha256 = this.computeSha256(content);
				if (currentSha256 !== entry.afterSha256) {
					mismatches.push({
						path: entry.path,
						expected: entry.afterSha256,
						actual: currentSha256,
					});
				}
			} else if (entry.afterExists && !exists) {
				mismatches.push({
					path: entry.path,
					expected: entry.afterSha256,
					actual: undefined,
				});
			} else if (!entry.afterExists && exists) {
				const content = await readFile(absolutePath);
				mismatches.push({
					path: entry.path,
					expected: undefined,
					actual: this.computeSha256(content),
				});
			}
		}

		return mismatches;
	}

	async restoreSnapshot(repositoryPath: string, patchSha: string): Promise<void> {
		const backupDirectory = await this.getBackupDirectory(repositoryPath, patchSha);
		const manifest = await this.readManifest(backupDirectory);
		const beforeDirectory = join(backupDirectory, 'before');

		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		const recoveryDirectory = join(
			gitDirectory,
			'patch-transfer',
			'backups',
			`.tmp-recovery-${patchSha}-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`,
		);
		const recoveryBeforeDirectory = join(recoveryDirectory, 'before');
		await mkdir(recoveryBeforeDirectory, { recursive: true });

		const recoveryEntries: RollbackPathEntry[] = [];
		for (const entry of manifest.paths) {
			const absolutePath = resolve(repositoryPath, entry.path);
			const exists = await this.fileExists(absolutePath);

			if (exists) {
				const content = await readFile(absolutePath);
				const sha256 = this.computeSha256(content);
				await writeFile(join(recoveryBeforeDirectory, sha256), content);
				recoveryEntries.push({
					path: entry.path,
					beforeExists: true,
					beforeSha256: sha256,
				});
			} else {
				recoveryEntries.push({
					path: entry.path,
					beforeExists: false,
				});
			}
		}

		const recoveryManifest: RollbackManifest = {
			version: 1,
			patchSha: `recovery-${patchSha}`,
			patchFileName: manifest.patchFileName,
			appliedAt: new Date().toISOString(),
			paths: recoveryEntries,
		};
		await this.writeManifest(recoveryDirectory, recoveryManifest);

		try {
			for (const entry of manifest.paths) {
				const absolutePath = resolve(repositoryPath, entry.path);

				if (entry.beforeExists && entry.beforeSha256) {
					const backupFilePath = join(beforeDirectory, entry.beforeSha256);
					const content = await readFile(backupFilePath);
					await mkdir(dirname(absolutePath), { recursive: true });
					await writeFile(absolutePath, content);
				} else if (!entry.beforeExists) {
					try {
						await unlink(absolutePath);
					} catch (error) {
						const fileError = error as NodeJS.ErrnoException;
						if (fileError.code !== 'ENOENT') {
							throw error;
						}
					}
				}
			}

			await rm(recoveryDirectory, { recursive: true, force: true });
		} catch (restoreError) {
			try {
				await this.performRestore(
					repositoryPath,
					recoveryEntries,
					recoveryBeforeDirectory,
				);
				await rm(recoveryDirectory, { recursive: true, force: true });
			} catch {
				// Recovery failure.
			}

			throw new Error(
				`Could not restore all files. ${this.getErrorMessage(restoreError)}`,
			);
		}
	}

	async deleteSnapshot(repositoryPath: string, patchSha: string): Promise<void> {
		const backupDirectory = await this.getBackupDirectory(repositoryPath, patchSha);
		try {
			await rm(backupDirectory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}

	private async performRestore(
		repositoryPath: string,
		entries: RollbackPathEntry[],
		beforeDirectory: string,
	): Promise<void> {
		for (const entry of entries) {
			const absolutePath = resolve(repositoryPath, entry.path);

			if (entry.beforeExists && entry.beforeSha256) {
				const backupFilePath = join(beforeDirectory, entry.beforeSha256);
				const content = await readFile(backupFilePath);
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, content);
			} else if (!entry.beforeExists) {
				try {
					await unlink(absolutePath);
				} catch (error) {
					const fileError = error as NodeJS.ErrnoException;
					if (fileError.code !== 'ENOENT') {
						throw error;
					}
				}
			}
		}
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			const fileStat = await stat(filePath);
			return fileStat.isFile();
		} catch {
			return false;
		}
	}

	private computeSha256(content: Buffer): string {
		return createHash('sha256').update(content).digest('hex');
	}

	private async writeManifest(directory: string, manifest: RollbackManifest): Promise<void> {
		const manifestPath = join(directory, 'manifest.json');
		const tempPath = join(
			directory,
			`manifest.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
		);

		await writeFile(tempPath, `${JSON.stringify(manifest, undefined, 2)}\n`, {
			encoding: 'utf8',
			flag: 'w',
		});

		await rename(tempPath, manifestPath);
	}

	private async readManifest(directory: string): Promise<RollbackManifest> {
		const manifestPath = join(directory, 'manifest.json');

		let contents: string;
		try {
			contents = await readFile(manifestPath, 'utf8');
		} catch (error) {
			throw new Error(
				`Rollback data is unavailable: ${this.getErrorMessage(error)}`,
			);
		}

		let value: unknown;
		try {
			value = JSON.parse(contents);
		} catch (error) {
			throw new Error(
				`Rollback data is corrupted: ${this.getErrorMessage(error)}`,
			);
		}

		if (!this.isValidManifest(value)) {
			throw new Error('Rollback data is corrupted: invalid manifest structure.');
		}

		return value;
	}

	private isValidManifest(value: unknown): value is RollbackManifest {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const candidate = value as Record<string, unknown>;
		return (
			candidate.version === 1 &&
			typeof candidate.patchSha === 'string' &&
			typeof candidate.patchFileName === 'string' &&
			typeof candidate.appliedAt === 'string' &&
			Array.isArray(candidate.paths) &&
			(candidate.paths as unknown[]).every(entry => this.isValidPathEntry(entry))
		);
	}

	private isValidPathEntry(value: unknown): value is RollbackPathEntry {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const entry = value as Record<string, unknown>;
		return (
			typeof entry.path === 'string' &&
			typeof entry.beforeExists === 'boolean'
		);
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
