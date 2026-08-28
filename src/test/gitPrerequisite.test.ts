import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ChangesViewModel } from '../changesViewModel';
import { GitService } from '../gitService';

const execFileAsync = promisify(execFile);

suite('Git prerequisite detection', function () {
	this.timeout(15_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('reports missing Git separately from a missing repository', async () => {
		const workspace = await createTemporaryDirectory();
		const gitService = new GitService('patch-transfer-intentionally-missing-git');

		assert.deepStrictEqual(
			await gitService.getRepositoryContext(workspace),
			{ status: 'missingGit' },
		);
		const model = new ChangesViewModel(gitService, () => workspace);
		await model.refresh();
		assert.strictEqual(model.snapshot.state, 'missingGit');
	});

	test('reports an ordinary folder as not being a Git repository', async () => {
		const workspace = await createTemporaryDirectory();

		assert.deepStrictEqual(
			await new GitService().getRepositoryContext(workspace),
			{ status: 'notRepository' },
		);
		const model = new ChangesViewModel(new GitService(), () => workspace);
		await model.refresh();
		assert.strictEqual(model.snapshot.state, 'noRepository');
	});

	test('keeps existing behavior for a valid Git repository', async () => {
		const repository = await createTemporaryDirectory();
		await runGit(repository, ['init', '--quiet']);
		await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
		await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
		await writeFile(join(repository, 'tracked.txt'), 'base\n', 'utf8');
		await runGit(repository, ['add', '.']);
		await runGit(repository, ['commit', '--quiet', '-m', 'initial history']);

		const context = await new GitService().getRepositoryContext(repository);
		assert.strictEqual(context.status, 'repository');
		if (context.status !== 'repository') {
			assert.fail('Expected a valid Git repository context.');
		}
		const model = new ChangesViewModel(new GitService(), () => repository);
		await model.refresh();
		assert.strictEqual(model.snapshot.state, 'clean');
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-git-test-'));
		temporaryDirectories.push(directory);
		await mkdir(directory, { recursive: true });
		return directory;
	}
});

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd: repositoryPath,
		encoding: 'utf8',
		windowsHide: true,
	});
	return stdout.trimEnd();
}
