import * as assert from 'assert';
import { execFile } from 'child_process';
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from '../auditHistoryService';
import { GitService } from '../gitService';
import {
	getPatchMetadataFileName,
	PatchMetadata,
	PatchMetadataService,
} from '../patchMetadataService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import {
	PatchesTreeProvider,
	PatchTreeItem,
	resolveTargetPatch,
} from '../patchesTreeProvider';
import { PatchTransferRepositoryContext } from '../repositoryContext';
import { RollbackService } from '../rollbackService';
import {
	TransferFolderService,
	TransferWorkflowService,
} from '../transferFolderService';

const execFileAsync = promisify(execFile);

suite('Patch Workflow Reliability Repair', function () {
	this.timeout(60_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('1. a single open repository is auto-selected', async () => {
		const root = await createTemporaryDirectory();
		const repository = join(root, 'only-repository');
		const context = new PatchTransferRepositoryContext(
			async () => [repository],
			() => undefined,
		);

		assert.strictEqual(await context.refresh(), resolve(repository));
		assert.strictEqual(context.repositoryPath, resolve(repository));
	});

	test('2. active editor selects its repository only when no repository is selected', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = join(root, 'repository-a');
		const repositoryB = join(root, 'repository-b');
		let activeEditorPath = join(repositoryB, 'src', 'active.ts');
		const context = new PatchTransferRepositoryContext(
			async () => [repositoryA, repositoryB],
			() => activeEditorPath,
		);

		await context.refresh();
		assert.strictEqual(context.repositoryPath, resolve(repositoryB));

		activeEditorPath = join(repositoryA, 'src', 'other.ts');
		await context.refresh();
		assert.strictEqual(context.repositoryPath, resolve(repositoryB));
	});

	test('3. explicitly selected repository B is the repository Patches scans', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = await createRepository(root, 'repository-a', 'base a\n');
		const repositoryB = await createRepository(root, 'repository-b', 'base b\n');
		await writeFile(await localPatchPath(repositoryA, 'a.patch'), 'not a patch\n', 'utf8');
		await writeFile(await localPatchPath(repositoryB, 'b.patch'), 'not a patch\n', 'utf8');
		const context = new PatchTransferRepositoryContext(
			async () => [repositoryA, repositoryB],
			() => undefined,
		);
		await context.select(async repositories =>
			repositories.find(repository => repository.path === resolve(repositoryB))?.path,
		);

		const { provider } = createServices();
		await provider.refresh(context.repositoryPath);
		assert.strictEqual(normalizePath(provider.repositoryPath), normalizePath(repositoryB));
		assert.deepStrictEqual(getPatchNames(provider), ['b.patch']);
	});

	test('4. watcher event from A cannot switch explicitly selected B', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = join(root, 'repository-a');
		const repositoryB = join(root, 'repository-b');
		const context = new PatchTransferRepositoryContext(
			async () => [repositoryA, repositoryB],
			() => undefined,
		);
		await context.select(async () => repositoryB);

		assert.strictEqual(
			context.isActiveLocalPatchFile(join(repositoryA, '.patch-transfer', 'from-a.patch')),
			false,
		);
		assert.strictEqual(
			context.isActiveLocalPatchFile(join(repositoryB, '.patch-transfer', 'from-b.patch')),
			true,
		);
		assert.strictEqual(context.repositoryPath, resolve(repositoryB));
	});

	test('5. refresh on B performs a fresh B scan instead of retaining A', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = await createRepository(root, 'repository-a', 'base a\n');
		const repositoryB = await createRepository(root, 'repository-b', 'base b\n');
		await writeFile(await localPatchPath(repositoryA, 'a.patch'), 'invalid a\n', 'utf8');
		await writeFile(await localPatchPath(repositoryB, 'b.patch'), 'invalid b\n', 'utf8');
		const { provider } = createServices();

		await provider.refresh(repositoryA);
		assert.deepStrictEqual(getPatchNames(provider), ['a.patch']);
		await provider.refresh(repositoryB);
		assert.deepStrictEqual(getPatchNames(provider), ['b.patch']);
		assert.strictEqual(normalizePath(provider.repositoryPath), normalizePath(repositoryB));
	});

	test('6. direct patch without metadata, state, or history is visible', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		await createPatch(
			source,
			join(target, '.patch-transfer'),
			'manual.patch',
			'manual change\n',
		);
		const { provider } = createServices();

		await provider.refresh(target);
		const item = getPatchItems(provider)[0];
		assert.strictEqual(item.patch.name, 'manual.patch');
		assert.strictEqual(item.patch.status, 'READY');
	});

	test('7. external filesystem copy appears after a fresh refresh', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalDirectory = join(root, 'external');
		const externalPatch = await createPatch(source, externalDirectory, 'copied.patch', 'copied\n');
		const { provider } = createServices();

		await provider.refresh(target);
		assert.strictEqual(provider.count, 0);
		const copiedPath = await localPatchPath(target, 'copied.patch');
		await copyFile(externalPatch, copiedPath);
		await provider.refresh(target);
		assert.deepStrictEqual(getPatchNames(provider), ['copied.patch']);
	});

	test('8. deleting a local patch removes its row after refresh', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repository', 'base\n');
		const patchPath = await localPatchPath(repository, 'delete-me.patch');
		await writeFile(patchPath, 'invalid patch\n', 'utf8');
		const { provider } = createServices();

		await provider.refresh(repository);
		assert.strictEqual(provider.count, 1);
		await rm(patchPath);
		await provider.refresh(repository);
		assert.strictEqual(provider.count, 0);
	});

	test('9. one INVALID patch does not hide another patch', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		await createPatch(
			source,
			join(target, '.patch-transfer'),
			'ready.patch',
			'ready change\n',
		);
		await writeFile(await localPatchPath(target, 'invalid.patch'), 'malformed\n', 'utf8');
		const { patchService } = createServices();

		const patches = await patchService.listPatches(target);
		assert.strictEqual(patches.length, 2);
		assert.strictEqual(patches.find(patch => patch.name === 'ready.patch')?.status, 'READY');
		assert.strictEqual(patches.find(patch => patch.name === 'invalid.patch')?.status, 'INVALID');
	});

	test('10. manual file import copies a valid external patch and it is immediately visible', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalPatch = await createPatch(source, join(root, 'desktop'), 'chosen.patch', 'chosen\n');
		const { patchService, provider } = createServices();

		const result = await patchService.importPatchFiles(target, [externalPatch]);
		assert.strictEqual(result.imported.length, 1);
		await provider.refresh(target);
		assert.strictEqual(getPatchItems(provider)[0].patch.status, 'READY');
		assert.strictEqual(getPatchItems(provider)[0].patch.name, 'chosen.patch');
	});

	test('11. manual file import works while remembered Transfer Folder is unavailable', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalPatch = await createPatch(source, join(root, 'manual'), 'fallback.patch', 'fallback\n');
		const missingTransferFolder = join(root, 'missing-usb');
		const { gitService, patchService } = createServices();
		const folders = new TransferFolderService(gitService);
		await folders.set(target, missingTransferFolder);
		const workflow = new TransferWorkflowService(folders, patchService);

		await assert.rejects(
			() => workflow.importAvailablePatches(target, async () => undefined),
			/Transfer folder is currently unavailable/,
		);
		const result = await patchService.importPatchFiles(target, [externalPatch]);
		assert.strictEqual(result.imported.length, 1);
	});

	test('12. manual file import never mutates the remembered Transfer Folder', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalPatch = await createPatch(source, join(root, 'manual'), 'manual.patch', 'manual\n');
		const rememberedFolder = join(root, 'remembered-transfer');
		await mkdir(rememberedFolder, { recursive: true });
		const { gitService, patchService } = createServices();
		const folders = new TransferFolderService(gitService);
		await folders.set(target, rememberedFolder);

		await patchService.importPatchFiles(target, [externalPatch]);
		assert.strictEqual(folders.get(target), resolve(rememberedFolder));
	});

	test('13. manual multi-file import deduplicates identical bytes by SHA-256', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalDirectory = join(root, 'manual');
		const firstPatch = await createPatch(source, externalDirectory, 'first.patch', 'same change\n');
		const secondPatch = join(externalDirectory, 'second.patch');
		await copyFile(firstPatch, secondPatch);
		const { patchService } = createServices();

		const result = await patchService.importPatchFiles(target, [firstPatch, secondPatch]);
		assert.strictEqual(result.imported.length, 1);
		assert.strictEqual(result.alreadyExists.length, 1);
		assert.strictEqual((await patchService.listPatches(target)).length, 1);
	});

	test('14. manual file import preserves a valid sidecar', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const externalPatch = await createPatch(source, join(root, 'manual'), 'metadata.patch', 'metadata\n');
		const { gitService, stateService, patchService } = createServices();
		const metadataService = new PatchMetadataService(gitService);
		const sha256 = await stateService.calculatePatchSha256(externalPatch);
		const metadata: PatchMetadata = {
			version: 1,
			patchSha256: sha256,
			patchFileName: 'metadata.patch',
			createdAt: new Date().toISOString(),
			source: { repositoryName: 'source' },
			chain: { previousPatchSha256: null },
			stats: { files: 1, additions: 1, deletions: 1 },
			paths: ['target.txt'],
			extensionVersion: '0.2.0',
		};
		await metadataService.writeSidecar(externalPatch, metadata);

		const result = await patchService.importPatchFiles(target, [externalPatch]);
		const importedPath = result.imported[0]?.patchPath;
		assert.ok(importedPath);
		const importedMetadata = await metadataService.readSidecar(importedPath);
		assert.ok(importedMetadata);
		assert.strictEqual(importedMetadata.patchSha256, metadata.patchSha256);
		assert.strictEqual(importedMetadata.patchFileName, metadata.patchFileName);
		assert.strictEqual(importedMetadata.source.repositoryName, 'source');
		assert.deepStrictEqual(importedMetadata.paths, ['target.txt']);
	});

	test('15. Source A transfers to unrelated Target B through their shared Transfer Folder', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source-a', 'base\n');
		const target = await createRepository(root, 'target-b', 'base\n');
		const transferFolder = join(root, 'shared-transfer');
		await mkdir(transferFolder, { recursive: true });
		const sourceHead = await runGit(source, ['rev-parse', 'HEAD']);
		const targetHead = await runGit(target, ['rev-parse', 'HEAD']);
		assert.notStrictEqual(sourceHead, targetHead);

		const sourceServices = createServices();
		const sourceFolders = new TransferFolderService(sourceServices.gitService);
		await sourceFolders.set(source, transferFolder);
		const sourceWorkflow = new TransferWorkflowService(sourceFolders, sourceServices.patchService);
		await writeFile(join(source, 'target.txt'), 'transferred change\n', 'utf8');
		const created = await sourceServices.patchService.createPatch(source, 'source A change');
		assert.notStrictEqual(created.status, 'noChanges');
		if (created.status === 'noChanges') {
			assert.fail('Expected Source A to create a patch');
		}
		await sourceWorkflow.transferCreatedPatch(source, created.patchPath, async () => undefined);

		const targetServices = createServices();
		const targetFolders = new TransferFolderService(targetServices.gitService);
		await targetFolders.set(target, transferFolder);
		const targetWorkflow = new TransferWorkflowService(targetFolders, targetServices.patchService);
		const imported = await targetWorkflow.importAvailablePatches(target, async () => undefined);
		assert.strictEqual(imported.status, 'completed');
		if (imported.status !== 'completed') {
			assert.fail('Expected Target B import to complete');
		}
		assert.strictEqual(imported.result.imported.length, 1);
		const patches = await targetServices.patchService.listPatches(target);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'READY');
	});

	test('16. Remove Local Patch deletes only the local patch and matching sidecar', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const transferFolder = join(root, 'transfer');
		const externalPatch = await createPatch(source, transferFolder, 'remove.patch', 'remove change\n');
		const { patchService } = createServices();
		const imported = await patchService.importPatch(target, externalPatch);
		assert.strictEqual(imported.status, 'imported');
		if (imported.status !== 'imported') {
			assert.fail('Expected patch import');
		}
		const sidecarPath = join(
			target,
			'.patch-transfer',
			getPatchMetadataFileName(imported.patchName),
		);
		await writeFile(sidecarPath, '{}\n', 'utf8');
		const projectBytes = await readFile(join(target, 'target.txt'));

		await patchService.removeLocalPatch(target, imported.patchPath);
		assert.strictEqual(await exists(imported.patchPath), false);
		assert.strictEqual(await exists(sidecarPath), false);
		assert.strictEqual(await exists(externalPatch), true);
		assert.deepStrictEqual(await readFile(join(target, 'target.txt')), projectBytes);
	});

	test('17. Remove Local Patch preserves applied state, audit history, and rollback data', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const patchPath = await createPatch(
			source,
			join(target, '.patch-transfer'),
			'applied.patch',
			'applied\n',
		);
		const { stateService, rollbackService, patchService, historyService } = createServices();
		const applied = await patchService.applyPatch(target, patchPath);
		assert.strictEqual(applied.status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);
		const stateBefore = await stateService.load(target);
		const historyBefore = await historyService.loadHistory(target);
		assert.strictEqual(await rollbackService.hasSnapshot(target, sha256), true);

		await patchService.removeLocalPatch(target, patchPath);
		assert.deepStrictEqual(await stateService.load(target), stateBefore);
		assert.deepStrictEqual(await historyService.loadHistory(target), historyBefore);
		assert.strictEqual(await rollbackService.hasSnapshot(target, sha256), true);
	});

	test('18. removing an APPLIED local patch does not break transactional Undo', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n');
		const target = await createRepository(root, 'target', 'base\n');
		const patchPath = await createPatch(
			source,
			join(target, '.patch-transfer'),
			'undo-after-remove.patch',
			'applied\n',
		);
		const { stateService, patchService } = createServices();
		assert.strictEqual((await patchService.applyPatch(target, patchPath)).status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		await patchService.removeLocalPatch(target, patchPath);
		await patchService.undoPatch(target, sha256);
		assert.strictEqual(await readFile(join(target, 'target.txt'), 'utf8'), 'base\n');
		assert.strictEqual((await stateService.load(target)).applied[sha256], undefined);
	});

	test('19. clicked B plus selected A removes B, never A', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repository', 'base\n');
		const patchAPath = await localPatchPath(repository, 'a.patch');
		const patchBPath = await localPatchPath(repository, 'b.patch');
		await writeFile(patchAPath, 'patch a\n', 'utf8');
		await writeFile(patchBPath, 'patch b\n', 'utf8');
		const { provider, patchService } = createServices();
		await provider.refresh(repository);
		const itemA = getPatchItems(provider).find(item => item.patch.name === 'a.patch');
		const itemB = getPatchItems(provider).find(item => item.patch.name === 'b.patch');
		assert.ok(itemA);
		assert.ok(itemB);

		const target = resolveTargetPatch(itemB, itemA, path => provider.getCurrentPatch(path));
		assert.strictEqual(target?.name, 'b.patch');
		await patchService.removeLocalPatch(repository, target?.path ?? '');
		assert.strictEqual(await exists(patchAPath), true);
		assert.strictEqual(await exists(patchBPath), false);
	});

	test('20. Open Local Patch Folder resolves and creates the selected repository folder', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = await createRepository(root, 'repository-a', 'a\n');
		const repositoryB = await createRepository(root, 'repository-b', 'b\n');
		const context = new PatchTransferRepositoryContext(
			async () => [repositoryA, repositoryB],
			() => undefined,
		);
		await context.select(async () => repositoryB);
		const { patchService } = createServices();

		const directory = await patchService.ensureLocalPatchDirectory(
			context.repositoryPath ?? '',
		);
		assert.strictEqual(directory, resolve(repositoryB, '.patch-transfer'));
		assert.strictEqual(context.getLocalPatchDirectory(), directory);
		assert.strictEqual(await exists(directory), true);
	});

	test('21. production manifest contributes all repository and patch management commands', async () => {
		const packageJson = JSON.parse(
			await readFile(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
		) as {
			activationEvents: string[];
			contributes: {
				commands: Array<{ command: string; title: string }>;
				menus: { 'view/item/context': Array<{ command: string }> };
			};
		};
		const expected = [
			'patch-transfer.selectRepository',
			'patch-transfer.importPatchFile',
			'patch-transfer.openLocalPatchFolder',
			'patch-transfer.removeLocalPatch',
		];

		for (const command of expected) {
			assert.ok(packageJson.activationEvents.includes(`onCommand:${command}`));
			assert.ok(packageJson.contributes.commands.some(item => item.command === command));
		}
		assert.ok(
			packageJson.contributes.menus['view/item/context']
				.some(item => item.command === 'patch-transfer.removeLocalPatch'),
		);
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-reliability-'));
		temporaryDirectories.push(directory);
		return directory;
	}
});

function createServices(): {
	gitService: GitService;
	stateService: PatchStateService;
	rollbackService: RollbackService;
	historyService: AuditHistoryService;
	patchService: PatchService;
	provider: PatchesTreeProvider;
} {
	const gitService = new GitService();
	const stateService = new PatchStateService(gitService);
	const rollbackService = new RollbackService(gitService);
	const historyService = new AuditHistoryService(gitService);
	const metadataService = new PatchMetadataService(gitService);
	const patchService = new PatchService(
		gitService,
		stateService,
		rollbackService,
		metadataService,
		historyService,
	);
	const provider = new PatchesTreeProvider(
		gitService,
		patchService,
		stateService,
		rollbackService,
	);
	return {
		gitService,
		stateService,
		rollbackService,
		historyService,
		patchService,
		provider,
	};
}

async function createRepository(
	parent: string,
	name: string,
	contents: string,
): Promise<string> {
	const repository = join(parent, name);
	await mkdir(repository, { recursive: true });
	await runGit(repository, ['init', '--quiet']);
	await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
	await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
	await runGit(repository, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(repository, 'target.txt'), contents, 'utf8');
	await runGit(repository, ['add', '.']);
	await runGit(repository, ['commit', '--quiet', '-m', `initial history for ${name}`]);
	return repository;
}

async function createPatch(
	sourceRepository: string,
	destinationDirectory: string,
	patchName: string,
	newContents: string,
): Promise<string> {
	await mkdir(destinationDirectory, { recursive: true });
	const patchPath = join(destinationDirectory, patchName);
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

async function localPatchPath(repositoryPath: string, patchName: string): Promise<string> {
	const directory = join(repositoryPath, '.patch-transfer');
	await mkdir(directory, { recursive: true });
	return join(directory, patchName);
}

function getPatchItems(provider: PatchesTreeProvider): PatchTreeItem[] {
	return provider.getChildren().filter(
		(item): item is PatchTreeItem => item instanceof PatchTreeItem,
	);
}

function getPatchNames(provider: PatchesTreeProvider): string[] {
	return getPatchItems(provider).map(item => item.patch.name).sort();
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function normalizePath(path: string | undefined): string | undefined {
	return path?.replace(/\\/g, '/').toLowerCase();
}

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd: repositoryPath,
		encoding: 'utf8',
		windowsHide: true,
	});
	return stdout.trimEnd();
}
