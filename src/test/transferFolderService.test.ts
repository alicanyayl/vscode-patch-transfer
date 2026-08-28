import * as assert from 'assert';
import { execFile } from 'child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { GitService } from '../gitService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import {
	TransferFolderMemento,
	TransferFolderService,
	TransferWorkflowService,
} from '../transferFolderService';

const execFileAsync = promisify(execFile);

suite('Persistent transfer folder workflow', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('stores first selection, reuses it, supports replacement, and remains repository-specific', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = join(root, 'repository-a');
		const repositoryB = join(root, 'repository-b');
		const folderA = join(root, 'transfer-a');
		const folderB = join(root, 'transfer-b');
		const state = new MemoryMemento();
		const folders = new TransferFolderService(state);
		let pickerCalls = 0;

		const first = await folders.getOrSelect(repositoryA, async () => {
			pickerCalls += 1;
			return folderA;
		});
		const reused = await folders.getOrSelect(repositoryA, async () => {
			pickerCalls += 1;
			return folderB;
		});

		assert.strictEqual(first, resolve(folderA));
		assert.strictEqual(reused, resolve(folderA));
		assert.strictEqual(pickerCalls, 1);
		assert.strictEqual(folders.get(repositoryB), undefined);

		await folders.select(repositoryA, async () => folderB);
		assert.strictEqual(folders.get(repositoryA), resolve(folderB));
		assert.strictEqual(folders.get(repositoryB), undefined);
	});

	test('automatically copies exact bytes, skips duplicate SHA, and preserves collision naming', async () => {
		const root = await createTemporaryDirectory();
		const repository = join(root, 'repository');
		const sourceA = join(root, 'source-a', 'update.patch');
		const sourceB = join(root, 'source-b', 'update.patch');
		const transferDirectory = join(root, 'transfer');
		const bytesA = Buffer.from([0, 10, 13, 255, 65]);
		const bytesB = Buffer.from([1, 2, 3, 4, 5]);
		await Promise.all([
			mkdir(join(root, 'source-a'), { recursive: true }),
			mkdir(join(root, 'source-b'), { recursive: true }),
			mkdir(transferDirectory, { recursive: true }),
		]);
		await writeFile(sourceA, bytesA);
		await writeFile(sourceB, bytesB);
		const patchService = new PatchService(new GitService());
		const workflow = new TransferWorkflowService(
			new TransferFolderService(new MemoryMemento()),
			patchService,
		);
		let pickerCalls = 0;
		const picker = async () => {
			pickerCalls += 1;
			return transferDirectory;
		};

		const copied = await workflow.transferCreatedPatch(repository, sourceA, picker);
		assert.strictEqual(copied.status, 'copied');
		if (copied.status !== 'copied') {
			assert.fail('Expected the first automatic transfer to copy.');
		}
		assert.deepStrictEqual(await readFile(copied.destinationPath), bytesA);

		const duplicate = await workflow.transferCreatedPatch(repository, sourceA, picker);
		assert.strictEqual(duplicate.status, 'alreadyExists');
		const collision = await workflow.transferCreatedPatch(repository, sourceB, picker);
		assert.strictEqual(collision.status, 'copied');
		if (collision.status !== 'copied') {
			assert.fail('Expected different bytes to use collision-safe naming.');
		}
		const sha256 = await new PatchStateService(new GitService()).calculatePatchSha256(sourceB);
		assert.strictEqual(collision.fileName, `update_${sha256.slice(0, 8)}.patch`);
		assert.deepStrictEqual(await readFile(collision.destinationPath), bytesB);
		assert.strictEqual(pickerCalls, 1);
	});

	test('copies a valid created patch even when push fails', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'source', 'base\n');
		const transferDirectory = join(root, 'transfer');
		await mkdir(transferDirectory, { recursive: true });
		await writeFile(join(repository, 'target.txt'), 'changed\n', 'utf8');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(new MemoryMemento());
		await folders.set(repository, transferDirectory);
		const workflow = new TransferWorkflowService(folders, patchService);

		const createResult = await patchService.createPatch(repository, 'feat: transfer after push failure');
		assert.strictEqual(createResult.status, 'pushFailed');
		if (createResult.status !== 'pushFailed') {
			assert.fail('Expected a repository without a remote to report pushFailed.');
		}
		const transferResult = await workflow.transferCreatedPatch(
			repository,
			createResult.patchPath,
			async () => assert.fail('Stored transfer folder should avoid the picker.'),
		);
		assert.strictEqual(transferResult.status, 'copied');
		if (transferResult.status !== 'copied') {
			assert.fail('Expected the created patch to transfer after push failure.');
		}
		assert.deepStrictEqual(
			await readFile(transferResult.destinationPath),
			await readFile(createResult.patchPath),
		);
	});

	test('batch imports direct valid patches, skips duplicates, isolates invalid files, and preserves state', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'import-source', 'base\n');
		const destination = await createRepository(root, 'import-destination', 'base\n');
		const transferDirectory = join(root, 'transfer');
		const nestedDirectory = join(transferDirectory, 'nested');
		await mkdir(nestedDirectory, { recursive: true });
		const patchA = await createPatch(source, transferDirectory, 'new.patch', 'change A\n');
		const patchB = await createPatch(source, transferDirectory, 'collision.patch', 'change B\n');
		await createPatch(source, nestedDirectory, 'nested.patch', 'nested-only change\n');
		await copyFile(patchA, join(transferDirectory, 'duplicate.patch'));
		await writeFile(join(transferDirectory, 'invalid.patch'), 'not a git patch\n', 'utf8');
		const projectPatchDirectory = join(destination, '.patch-transfer');
		const occupiedCollisionPath = join(projectPatchDirectory, 'collision.patch');
		const occupiedBytes = Buffer.from('occupied collision filename\n');
		await mkdir(projectPatchDirectory, { recursive: true });
		await writeFile(occupiedCollisionPath, occupiedBytes);
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(new MemoryMemento());
		const workflow = new TransferWorkflowService(folders, patchService);
		let pickerCalls = 0;
		const picker = async () => {
			pickerCalls += 1;
			return transferDirectory;
		};

		const first = await workflow.importAvailablePatches(destination, picker);
		assert.strictEqual(first.status, 'completed');
		if (first.status !== 'completed') {
			assert.fail('Expected folder import to complete.');
		}
		assert.strictEqual(first.result.imported.length, 2);
		assert.strictEqual(first.result.alreadyExists.length, 1);
		assert.deepStrictEqual(first.result.invalid.map(item => item.patchName), ['invalid.patch']);
		const renamedCollision = first.result.imported.find(item => item.renamed);
		assert.ok(renamedCollision);
		assert.deepStrictEqual(await readFile(renamedCollision?.patchPath ?? ''), await readFile(patchB));
		assert.deepStrictEqual(await readFile(occupiedCollisionPath), occupiedBytes);
		assert.ok(!(await readdir(projectPatchDirectory)).includes('nested.patch'));

		const second = await workflow.importAvailablePatches(
			destination,
			async () => assert.fail('Remembered import folder should avoid the picker.'),
		);
		assert.strictEqual(second.status, 'completed');
		if (second.status !== 'completed') {
			assert.fail('Expected the remembered folder import to complete.');
		}
		assert.strictEqual(second.result.imported.length, 0);
		assert.strictEqual(second.result.alreadyExists.length, 3);
		assert.strictEqual(second.result.invalid.length, 1);
		assert.strictEqual(pickerCalls, 1);
		const state = await new PatchStateService(gitService).load(destination);
		assert.deepStrictEqual(state.created, {});
		assert.deepStrictEqual(state.applied, {});
		for (const imported of first.result.imported) {
			assert.strictEqual(
				(await patchService.listPatches(destination))
					.find(patch => patch.path === imported.patchPath)?.status,
				'READY',
			);
		}
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-folder-test-'));
		temporaryDirectories.push(directory);
		return directory;
	}
});

class MemoryMemento implements TransferFolderMemento {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

async function createRepository(parent: string, name: string, contents: string): Promise<string> {
	const repository = join(parent, name);
	await mkdir(repository, { recursive: true });
	await runGit(repository, ['init', '--quiet']);
	await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
	await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
	await runGit(repository, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(repository, 'target.txt'), contents, 'utf8');
	await runGit(repository, ['add', '.']);
	await runGit(repository, ['commit', '--quiet', '-m', 'initial history']);
	return repository;
}

async function createPatch(
	sourceRepository: string,
	destinationDirectory: string,
	patchName: string,
	newContents: string,
): Promise<string> {
	const patchPath = join(destinationDirectory, patchName);
	await mkdir(destinationDirectory, { recursive: true });
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
