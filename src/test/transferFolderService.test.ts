import * as assert from 'assert';
import { execFile } from 'child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from '../auditHistoryService';
import { GitService } from '../gitService';
import { PatchMetadataService } from '../patchMetadataService';
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

	test('1. First explicit transfer-folder selection is persisted', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-1', 'base\n');
		const transferDir = join(root, 'transfer-1');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();
		const folders = new TransferFolderService(gitService);

		let pickerCalls = 0;
		const selected = await folders.getOrSelect(repository, async () => {
			pickerCalls += 1;
			return transferDir;
		});

		assert.strictEqual(selected, resolve(transferDir));
		assert.strictEqual(pickerCalls, 1);
		assert.strictEqual(folders.get(repository), resolve(transferDir));
		assert.strictEqual(
			await gitService.getLocalConfig(repository, 'patchTransfer.transferFolder'),
			resolve(transferDir),
		);
	});

	test('2. Subsequent Create Patch reuses it without picker', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-2', 'base\n');
		const transferDir = join(root, 'transfer-2');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		await writeFile(join(repository, 'target.txt'), 'new content\n', 'utf8');
		const patchResult = await patchService.createPatch(repository, 'feat: test 2');
		if (patchResult.status === 'noChanges') {
			assert.fail('Should have changes');
		}

		const transferResult = await workflow.transferCreatedPatch(
			repository,
			patchResult.patchPath,
			async () => {
				assert.fail('Picker should not be called when transfer folder is already configured');
			},
		);

		assert.strictEqual(transferResult.status, 'copied');
		assert.strictEqual(transferResult.folderPath, resolve(transferDir));
	});

	test('3. Subsequent Import Patch reuses it without picker', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source-3', 'base\n');
		const destination = await createRepository(root, 'dest-3', 'base\n');
		const transferDir = join(root, 'transfer-3');
		await mkdir(transferDir, { recursive: true });
		await createPatch(source, transferDir, 'p3.patch', 'patch content\n');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(destination, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		const importResult = await workflow.importAvailablePatches(
			destination,
			async () => {
				assert.fail('Picker should not be called when transfer folder is already configured');
			},
		);

		assert.strictEqual(importResult.status, 'completed');
		assert.strictEqual(importResult.folderPath, resolve(transferDir));
		assert.strictEqual(importResult.result.imported.length, 1);
	});

	test('4. Explicit Set Transfer Folder changes it', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-4', 'base\n');
		const folderA = join(root, 'transfer-4a');
		const folderB = join(root, 'transfer-4b');
		await mkdir(folderA, { recursive: true });
		await mkdir(folderB, { recursive: true });
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, folderA);
		const workflow = new TransferWorkflowService(folders, patchService);

		assert.strictEqual(folders.get(repository), resolve(folderA));

		const newSelected = await workflow.setTransferFolder(repository, async () => folderB);
		assert.strictEqual(newSelected, resolve(folderB));
		assert.strictEqual(folders.get(repository), resolve(folderB));
		assert.strictEqual(
			await gitService.getLocalConfig(repository, 'patchTransfer.transferFolder'),
			resolve(folderB),
		);
	});

	test('5. No other operation changes it', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-5', 'base\n');
		const transferDir = join(root, 'transfer-5');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, transferDir);

		await patchService.listPatches(repository);
		assert.strictEqual(folders.get(repository), resolve(transferDir));
	});

	test('6. Repository is moved to a different absolute filesystem path: configured Transfer Folder survives', async () => {
		const root = await createTemporaryDirectory();
		const origRepo = await createRepository(root, 'orig-repo-6', 'base\n');
		const transferDir = join(root, 'transfer-6');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();
		const folders = new TransferFolderService(gitService);
		await folders.set(origRepo, transferDir);
		assert.strictEqual(folders.get(origRepo), resolve(transferDir));

		// Move repository to another location
		const movedRepo = join(root, 'moved-repo-6');
		await rename(origRepo, movedRepo);

		const newService = new TransferFolderService(gitService);
		assert.strictEqual(newService.get(movedRepo), resolve(transferDir));
	});

	test('7. New VS Code workspace state / new MemoryMemento: repository-local Transfer Folder still survives', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-7', 'base\n');
		const transferDir = join(root, 'transfer-7');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();

		const memento1 = new MemoryMemento();
		const folders1 = new TransferFolderService(gitService, memento1);
		await folders1.set(repository, transferDir);

		// Fresh session with empty memento (new workspace)
		const memento2 = new MemoryMemento();
		const folders2 = new TransferFolderService(gitService, memento2);
		assert.strictEqual(folders2.get(repository), resolve(transferDir));
	});

	test('8. Legacy workspaceState value migrates once when possible', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-8', 'base\n');
		const legacyDir = join(root, 'legacy-transfer-8');
		await mkdir(legacyDir, { recursive: true });
		const gitService = new GitService();

		// Populate legacy memento
		const memento = new MemoryMemento();
		const normalized = process.platform === 'win32' ? resolve(repository).toLowerCase() : resolve(repository);
		await memento.update('patchTransfer.transferFolders', { [normalized]: resolve(legacyDir) });

		assert.strictEqual(
			await gitService.getLocalConfig(repository, 'patchTransfer.transferFolder'),
			undefined,
		);

		const folders = new TransferFolderService(gitService, memento);
		const resolved = folders.get(repository);
		assert.strictEqual(resolved, resolve(legacyDir));

		// Verify migrated into Git local config
		assert.strictEqual(
			await gitService.getLocalConfig(repository, 'patchTransfer.transferFolder'),
			resolve(legacyDir),
		);
	});

	test('9. Missing USB/folder: operation fails clearly, configured folder is NOT cleared or changed', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-9', 'base\n');
		const missingDir = join(root, 'missing-usb-drive-9');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, missingDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		const patchPath = join(root, 'sample.patch');
		await writeFile(patchPath, 'diff\n', 'utf8');

		await assert.rejects(
			async () => workflow.transferCreatedPatch(repository, patchPath, async () => {
				assert.fail('Picker should not be called');
			}),
			(error: Error) => {
				assert.ok(
					error.message.includes(`Transfer folder is currently unavailable:\n${resolve(missingDir)}`),
					`Expected unavailable message but got: ${error.message}`,
				);
				assert.ok(error.message.includes('Use "Set Transfer Folder" to change it.'));
				return true;
			},
		);

		// Configured folder remains unchanged
		assert.strictEqual(folders.get(repository), resolve(missingDir));
	});

	test('10. Folder becomes available again: existing configured value is reused automatically', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-10', 'base\n');
		const usbDir = join(root, 'usb-reconnect-10');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, usbDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		const patchPath = join(root, 'sample10.patch');
		await writeFile(patchPath, 'diff10\n', 'utf8');

		// USB reconnects / directory becomes available
		await mkdir(usbDir, { recursive: true });

		const result = await workflow.transferCreatedPatch(repository, patchPath, async () => {
			assert.fail('Picker should not be called');
		});

		assert.strictEqual(result.status, 'copied');
		assert.strictEqual(result.folderPath, resolve(usbDir));
	});

	test('11. Source Create Patch with transfer unavailable: local patch still exists', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-11', 'base\n');
		const missingDir = join(root, 'missing-usb-11');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, missingDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		await writeFile(join(repository, 'target.txt'), 'created for test 11\n', 'utf8');
		const createResult = await patchService.createPatch(repository, 'feat: test 11');
		if (createResult.status === 'noChanges') {
			assert.fail('Should have created patch');
		}

		await assert.rejects(
			async () => workflow.transferCreatedPatch(repository, createResult.patchPath, async () => {
				assert.fail('Picker should not be called');
			}),
			/Transfer folder is currently unavailable:/,
		);

		const localContent = await readFile(createResult.patchPath, 'utf8');
		assert.ok(localContent.length > 0);
	});

	test('12. Source Create Patch with available transfer folder: exact patch bytes + matching sidecar are copied', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo-12', 'base\n');
		const transferDir = join(root, 'transfer-12');
		await mkdir(transferDir, { recursive: true });
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);
		const folders = new TransferFolderService(gitService);
		await folders.set(repository, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		await writeFile(join(repository, 'target.txt'), 'created for test 12\n', 'utf8');
		const createResult = await patchService.createPatch(repository, 'feat: test 12');
		if (createResult.status === 'noChanges') {
			assert.fail('Should have created patch');
		}

		const transferResult = await workflow.transferCreatedPatch(
			repository,
			createResult.patchPath,
			async () => assert.fail('Should not pick'),
		);

		assert.strictEqual(transferResult.status, 'copied');
		const localBytes = await readFile(createResult.patchPath);
		const transferredBytes = await readFile(transferResult.destinationPath);
		assert.deepStrictEqual(transferredBytes, localBytes);

		const sidecarPath = join(transferDir, `${createResult.patchName}meta.json`);
		const sidecarContent = await readFile(sidecarPath, 'utf8');
		assert.ok(sidecarContent.includes(await stateService.calculatePatchSha256(createResult.patchPath)));
	});

	test('13. Target Import from configured folder: direct valid .patch is imported to target .patch-transfer', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source-13', 'base\n');
		const destination = await createRepository(root, 'dest-13', 'base\n');
		const transferDir = join(root, 'transfer-13');
		await mkdir(transferDir, { recursive: true });
		await createPatch(source, transferDir, 'valid13.patch', 'change 13\n');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(destination, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		const result = await workflow.importAvailablePatches(destination, async () => {
			assert.fail('Should not prompt');
		});

		assert.strictEqual(result.status, 'completed');
		assert.strictEqual(result.result.imported.length, 1);
		const importedPath = join(destination, '.patch-transfer', 'valid13.patch');
		assert.ok(await readFile(importedPath, 'utf8'));
	});

	test('14. Imported patch is visible from PatchService/Patches provider immediately after refresh', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source-14', 'base\n');
		const destination = await createRepository(root, 'dest-14', 'base\n');
		const transferDir = join(root, 'transfer-14');
		await mkdir(transferDir, { recursive: true });
		await createPatch(source, transferDir, 'valid14.patch', 'change 14\n');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(destination, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		await workflow.importAvailablePatches(destination, async () => assert.fail('Should not prompt'));

		const patches = await patchService.listPatches(destination);
		const found = patches.find(p => p.name === 'valid14.patch');
		assert.ok(found);
		assert.strictEqual(found.status, 'READY');
	});

	test('15. Duplicate patch import remains deduplicated', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source-15', 'base\n');
		const destination = await createRepository(root, 'dest-15', 'base\n');
		const transferDir = join(root, 'transfer-15');
		await mkdir(transferDir, { recursive: true });
		await createPatch(source, transferDir, 'dedup15.patch', 'change 15\n');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const folders = new TransferFolderService(gitService);
		await folders.set(destination, transferDir);
		const workflow = new TransferWorkflowService(folders, patchService);

		const first = await workflow.importAvailablePatches(destination, async () => assert.fail('No pick'));
		assert.strictEqual(first.status, 'completed');
		assert.strictEqual(first.result.imported.length, 1);

		const second = await workflow.importAvailablePatches(destination, async () => assert.fail('No pick'));
		assert.strictEqual(second.status, 'completed');
		assert.strictEqual(second.result.imported.length, 0);
		assert.strictEqual(second.result.alreadyExists.length, 1);
	});

	test('16. Repo A and Repo B maintain independent settings', async () => {
		const root = await createTemporaryDirectory();
		const repoA = await createRepository(root, 'repo-16a', 'base\n');
		const repoB = await createRepository(root, 'repo-16b', 'base\n');
		const transferA = join(root, 'transfer-16a');
		const transferB = join(root, 'transfer-16b');
		await mkdir(transferA, { recursive: true });
		await mkdir(transferB, { recursive: true });

		const gitService = new GitService();
		const folders = new TransferFolderService(gitService);
		await folders.set(repoA, transferA);
		await folders.set(repoB, transferB);

		assert.strictEqual(folders.get(repoA), resolve(transferA));
		assert.strictEqual(folders.get(repoB), resolve(transferB));

		const transferA2 = join(root, 'transfer-16a2');
		await mkdir(transferA2, { recursive: true });
		await folders.set(repoA, transferA2);

		assert.strictEqual(folders.get(repoA), resolve(transferA2));
		assert.strictEqual(folders.get(repoB), resolve(transferB));
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
