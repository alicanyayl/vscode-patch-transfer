import { execFile } from 'child_process';
import { isAbsolute, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const gitRequiredMessage = 'Git is required to use Patch Transfer. Install Git and reload VS Code.';
export const repositoryRequiredMessage = 'Open a Git repository to use Patch Transfer.';

export type GitRepositoryContext =
	| { status: 'repository'; repositoryPath: string }
	| { status: 'missingGit' }
	| { status: 'notRepository' };

export class GitExecutableNotFoundError extends Error {
	constructor() {
		super(gitRequiredMessage);
		this.name = 'GitExecutableNotFoundError';
	}
}

export interface GitChange {
	status: string;
	path: string;
	originalPath?: string;
}

export class GitService {
	constructor(private readonly gitExecutable = 'git') {}

	private async runGit(repositoryPath: string, args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync(this.gitExecutable, args, {
				cwd: repositoryPath,
				encoding: 'utf8',
				windowsHide: true,
			});

			return stdout.trimEnd();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new GitExecutableNotFoundError();
			}

			const gitError = error as Error & { stderr?: string; stdout?: string };
			const details = gitError.stderr?.trim() || gitError.stdout?.trim() || gitError.message;
			throw new Error(details || `Git command failed: git ${args.join(' ')}`);
		}
	}

	async getRepositoryContext(workspacePath: string): Promise<GitRepositoryContext> {
		try {
			return {
				status: 'repository',
				repositoryPath: await this.runGit(workspacePath, ['rev-parse', '--show-toplevel']),
			};
		} catch (error) {
			return error instanceof GitExecutableNotFoundError
				? { status: 'missingGit' }
				: { status: 'notRepository' };
		}
	}

	async getRepositoryRoot(workspacePath: string): Promise<string | undefined> {
		const context = await this.getRepositoryContext(workspacePath);
		return context.status === 'repository' ? context.repositoryPath : undefined;
	}

	async getGitDirectory(repositoryPath: string): Promise<string> {
		const gitDirectory = await this.runGit(repositoryPath, ['rev-parse', '--git-dir']);
		return isAbsolute(gitDirectory) ? gitDirectory : resolve(repositoryPath, gitDirectory);
	}

	async getChanges(workspacePath: string): Promise<GitChange[] | undefined> {
		try {
			const stdout = await this.runGit(workspacePath, ['status', '--porcelain', '-z']);
			const entries = stdout.split('\0');
			const changes: GitChange[] = [];

			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				if (entry.length < 4) {
					continue;
				}

				const status = entry.slice(0, 2);
				const path = entry.slice(3);
				const originalPath = status.includes('R') ? entries[++index] : undefined;

				if (
					(status === '??' || /[MADRU]/.test(status)) &&
					!this.isPatchTransferPath(path)
				) {
					changes.push({ status, path, originalPath });
				}
			}

			return changes;
		} catch {
			return undefined;
		}
	}

	private isPatchTransferPath(filePath: string): boolean {
		const normalizedPath = filePath.replace(/\\/g, '/');
		return normalizedPath === '.patch-transfer' || normalizedPath.startsWith('.patch-transfer/');
	}

	async hasChanges(repositoryPath: string): Promise<boolean> {
		return (await this.runGit(repositoryPath, ['status', '--porcelain'])).length > 0;
	}

	async getExcludePath(repositoryPath: string): Promise<string> {
		const excludePath = await this.runGit(repositoryPath, ['rev-parse', '--git-path', 'info/exclude']);
		return isAbsolute(excludePath) ? excludePath : resolve(repositoryPath, excludePath);
	}

	async stageAllChanges(repositoryPath: string): Promise<void> {
		await this.runGit(repositoryPath, ['add', '--all']);
		await this.runGit(repositoryPath, ['reset', '--quiet', 'HEAD', '--', '.patch-transfer']);
	}

	async hasStagedChanges(repositoryPath: string): Promise<boolean> {
		return (await this.runGit(repositoryPath, ['diff', '--cached', '--name-only', 'HEAD'])).length > 0;
	}

	async createPatch(repositoryPath: string, patchPath: string): Promise<void> {
		await this.runGit(repositoryPath, [
			'diff',
			'--cached',
			'--binary',
			'--full-index',
			'--no-color',
			'HEAD',
			`--output=${patchPath}`,
		]);
	}

	async validatePatch(repositoryPath: string, patchPath: string): Promise<void> {
		await this.runGit(repositoryPath, ['apply', '--stat', '--', patchPath]);
	}

	async getPatchNumStat(repositoryPath: string, patchPath: string): Promise<string> {
		return this.runGit(repositoryPath, ['apply', '--numstat', '--', patchPath]);
	}

	async getPatchSummary(repositoryPath: string, patchPath: string): Promise<string> {
		return this.runGit(repositoryPath, ['apply', '--summary', '--', patchPath]);
	}

	async checkPatch(repositoryPath: string, patchPath: string): Promise<void> {
		await this.runGit(repositoryPath, ['apply', '--check', '--', patchPath]);
	}

	async applyPatch(repositoryPath: string, patchPath: string): Promise<void> {
		await this.runGit(repositoryPath, ['apply', '--', patchPath]);
	}

	async commit(repositoryPath: string, message: string): Promise<void> {
		await this.runGit(repositoryPath, ['commit', '-m', message]);
	}

	async push(repositoryPath: string): Promise<void> {
		await this.runGit(repositoryPath, ['push']);
	}
}
