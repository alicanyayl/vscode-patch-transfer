import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { GitService } from '../gitService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';

const execFileAsync = promisify(execFile);

suite('Patch application workflow', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('A, B, D, F: applies against independent history and persists SHA state', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(
			root,
			'destination',
			'base\n',
			'unrelated destination history',
			true,
		);
		const patchPath = await createPatch(
			source,
			destination,
			'2026-08-27_120000.patch',
			'changed\n',
		);
		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const before = await patchService.listPatches(destination);
		assert.strictEqual(before.length, 1);
		assert.strictEqual(before[0].status, 'READY');

		const applied = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(applied.status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'changed\n');

		const after = await patchService.listPatches(destination);
		assert.strictEqual(after[0].status, 'APPLIED');
		assert.match(after[0].sha256 ?? '', /^[a-f0-9]{64}$/);

		const stateService = new PatchStateService(gitService);
		const state = await stateService.load(destination);
		assert.strictEqual(state.version, 1);
		assert.strictEqual(state.applied[after[0].sha256 ?? '']?.fileName, before[0].name);

		const restartedService = new PatchService(new GitService());
		const afterRestart = await restartedService.listPatches(destination);
		assert.strictEqual(afterRestart[0].status, 'APPLIED');

		const repeated = await restartedService.applyPatch(destination, patchPath);
		assert.strictEqual(repeated.status, 'alreadyApplied');
	});

	test('C: classifies a context mismatch as CONFLICT without changing files', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(
			source,
			destination,
			'2026-08-27_130000.patch',
			'patched\n',
		);
		await writeFile(join(destination, 'target.txt'), 'manual conflict\n', 'utf8');
		const patchService = new PatchService(new GitService());

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');
		assert.match(patches[0].error ?? '', /patch does not apply|patch failed/i);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'notReady');
		if (result.status === 'notReady') {
			assert.strictEqual(result.patchStatus, 'CONFLICT');
		}
		assert.strictEqual(
			await readFile(join(destination, 'target.txt'), 'utf8'),
			'manual conflict\n',
		);
	});

	test('E: treats replaced contents under the same filename as a new patch', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchName = '2026-08-27_140000.patch';
		const patchPath = await createPatch(source, destination, patchName, 'first\n');
		const patchService = new PatchService(new GitService());

		assert.strictEqual((await patchService.applyPatch(destination, patchPath)).status, 'applied');
		const firstPatch = (await patchService.listPatches(destination))[0];
		assert.strictEqual(firstPatch.status, 'APPLIED');

		await runGit(source, ['add', 'target.txt']);
		await runGit(source, ['commit', '--quiet', '-m', 'first source change']);
		await createPatch(source, destination, patchName, 'second\n');

		const replacedPatch = (await patchService.listPatches(destination))[0];
		assert.strictEqual(replacedPatch.status, 'READY');
		assert.notStrictEqual(replacedPatch.sha256, firstPatch.sha256);

		assert.strictEqual((await patchService.applyPatch(destination, patchPath)).status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'second\n');
	});

	test('classifies malformed patches as INVALID and preserves malformed state', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchDirectory = join(destination, '.patch-transfer');
		const invalidPatchPath = join(patchDirectory, 'bad.patch');
		await mkdir(patchDirectory, { recursive: true });
		await writeFile(invalidPatchPath, 'this is not a patch\n', 'utf8');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'INVALID');

		const stateService = new PatchStateService(gitService);
		const statePath = await stateService.getStatePath(destination);
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(statePath, '{ malformed', 'utf8');

		await assert.rejects(() => patchService.listPatches(destination), /state is malformed/i);
		await assert.rejects(
			() => patchService.applyPatch(destination, invalidPatchPath),
			/state is malformed/i,
		);
		assert.strictEqual(await readFile(statePath, 'utf8'), '{ malformed');
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'base\n');
	});

	test('warns through the plan when an older patch is not applied', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		await createPatch(source, destination, '2026-08-27_120000.patch', 'older\n');
		await writeFile(join(source, 'target.txt'), 'newer\n', 'utf8');
		const newerPatchPath = join(
			destination,
			'.patch-transfer',
			'2026-08-27_150000.patch',
		);
		await runGit(source, [
			'diff',
			'--binary',
			'--full-index',
			'--no-color',
			'HEAD',
			`--output=${newerPatchPath}`,
		]);
		const patchService = new PatchService(new GitService());

		const plan = await patchService.preparePatchApplication(destination, newerPatchPath);
		assert.strictEqual(plan.patch.status, 'READY');
		assert.strictEqual(plan.olderUnappliedPatchName, '2026-08-27_120000.patch');
	});

	test('preserves the existing create, validate, commit, and push workflow', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'internet-side', 'base\n', 'initial history');
		const remote = join(root, 'remote.git');
		await runGit(root, ['init', '--bare', '--quiet', remote]);
		await runGit(repository, ['remote', 'add', 'origin', remote]);
		await runGit(repository, ['push', '--quiet', '-u', 'origin', 'HEAD']);
		await writeFile(join(repository, 'target.txt'), 'internet change\n', 'utf8');
		const patchService = new PatchService(new GitService());

		const result = await patchService.createPatch(repository);
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(await runGit(repository, ['status', '--porcelain']), '');
		const patchFiles = (await readdir(join(repository, '.patch-transfer')))
			.filter(fileName => fileName.endsWith('.patch'));
		assert.strictEqual(patchFiles.length, 1);

		const branch = await runGit(repository, ['branch', '--show-current']);
		assert.strictEqual(
			await runGit(repository, ['rev-parse', 'HEAD']),
			await runGit(remote, ['rev-parse', `refs/heads/${branch}`]),
		);
	});

	test('reports state persistence failure only after applying the working-tree change', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(
			source,
			destination,
			'2026-08-27_160000.patch',
			'applied without state\n',
		);
		const gitService = new GitService();
		const failingStateService = new class extends PatchStateService {
			override async recordApplied(
				repositoryPath: string,
				sha256: string,
				fileName: string,
				appliedAt?: Date,
			): Promise<void> {
				void repositoryPath;
				void sha256;
				void fileName;
				void appliedAt;
				throw new Error('simulated persistence failure');
			}
		}(gitService);
		const patchService = new PatchService(gitService, failingStateService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'stateSaveFailed');
		assert.strictEqual(
			await readFile(join(destination, 'target.txt'), 'utf8'),
			'applied without state\n',
		);
		assert.strictEqual((await new PatchService(gitService).listPatches(destination))[0].status, 'CONFLICT');
	});

	test('stores state in the actual Git directory for a worktree', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'main', 'base\n', 'main history');
		const worktree = join(root, 'linked-worktree');
		await runGit(repository, ['worktree', 'add', '--quiet', '-b', 'closed-worktree', worktree]);
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = 'a'.repeat(64);

		await stateService.recordApplied(worktree, sha256, 'worktree.patch');

		const gitDirectory = await gitService.getGitDirectory(worktree);
		const statePath = await stateService.getStatePath(worktree);
		assert.strictEqual(resolve(dirname(dirname(statePath))), resolve(gitDirectory));
		assert.strictEqual((await stateService.load(worktree)).applied[sha256].fileName, 'worktree.patch');
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-test-'));
		temporaryDirectories.push(directory);
		return directory;
	}
});

async function createRepository(
	parent: string,
	name: string,
	targetContents: string,
	commitMessage: string,
	includeUnrelatedFile = false,
): Promise<string> {
	const repository = join(parent, name);
	await mkdir(repository, { recursive: true });
	await runGit(repository, ['init', '--quiet']);
	await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
	await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
	await runGit(repository, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(repository, 'target.txt'), targetContents, 'utf8');
	if (includeUnrelatedFile) {
		await writeFile(join(repository, 'unrelated.txt'), 'independent history\n', 'utf8');
	}
	await runGit(repository, ['add', '.']);
	await runGit(repository, ['commit', '--quiet', '-m', commitMessage]);
	return repository;
}

async function createPatch(
	sourceRepository: string,
	destinationRepository: string,
	patchName: string,
	newContents: string,
): Promise<string> {
	const patchDirectory = join(destinationRepository, '.patch-transfer');
	const patchPath = join(patchDirectory, patchName);
	await mkdir(patchDirectory, { recursive: true });
	await writeFile(join(sourceRepository, 'target.txt'), newContents, 'utf8');
	await runGit(sourceRepository, [
		'diff',
		'--binary',
		'--full-index',
		'--no-color',
		'HEAD',
		`--output=${patchPath}`,
	]);
	return patchPath;
}

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd: repositoryPath,
		encoding: 'utf8',
		windowsHide: true,
	});
	return stdout.trimEnd();
}
