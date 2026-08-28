import * as assert from 'assert';
import { execFile } from 'child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { CommitMessageManager } from '../commitMessageManager';
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

	test('uses the exact manual message, records CREATED, commits, pushes, and clears', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'internet-side', 'base\n', 'initial history');
		const remote = join(root, 'remote.git');
		await runGit(root, ['init', '--bare', '--quiet', remote]);
		await runGit(repository, ['remote', 'add', 'origin', remote]);
		await runGit(repository, ['push', '--quiet', '-u', 'origin', 'HEAD']);
		await writeFile(join(repository, 'target.txt'), 'internet change\n', 'utf8');
		const patchService = new PatchService(new GitService());
		const gitInputRepository = {
			inputBox: { value: 'feat: add course configuration\n\nPreserve the detailed body.' },
		};
		const messageManager = createMessageManager(gitInputRepository);
		const messageSession = await messageManager.beginCreatePatch();

		const result = await patchService.createPatch(repository, messageSession.message);
		assert.strictEqual(result.status, 'success');
		messageSession.complete(true);
		assert.strictEqual(
			await runGit(repository, ['log', '-1', '--pretty=%B']),
			'feat: add course configuration\n\nPreserve the detailed body.',
		);
		assert.strictEqual(gitInputRepository.inputBox.value, '');
		assert.strictEqual(messageManager.getSnapshot().message, '');
		assert.strictEqual(await runGit(repository, ['status', '--porcelain']), '');
		const patchFiles = (await readdir(join(repository, '.patch-transfer')))
			.filter(fileName => fileName.endsWith('.patch'));
		assert.strictEqual(patchFiles.length, 1);
		const patches = await patchService.listPatches(repository);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'CREATED');
		assert.match(patches[0].sha256 ?? '', /^[a-f0-9]{64}$/);

		const state = await new PatchStateService(new GitService()).load(repository);
		assert.strictEqual(
			state.created[patches[0].sha256 ?? '']?.fileName,
			patches[0].name,
		);
		assert.strictEqual(
			(await new PatchService(new GitService()).listPatches(repository))[0].status,
			'CREATED',
		);

		const branch = await runGit(repository, ['branch', '--show-current']);
		assert.strictEqual(
			await runGit(repository, ['rev-parse', 'HEAD']),
			await runGit(remote, ['rev-parse', `refs/heads/${branch}`]),
		);
	});

	test('blocks an empty commit message before changing repository state', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'empty-message', 'base\n', 'initial history');
		await writeFile(join(repository, 'target.txt'), 'uncommitted change\n', 'utf8');
		const patchService = new PatchService(new GitService());
		const statusBefore = await runGit(repository, ['status', '--porcelain']);
		const headBefore = await runGit(repository, ['rev-parse', 'HEAD']);

		await assert.rejects(
			() => patchService.createPatch(repository, ' \r\n\t '),
			/Enter a commit message before creating the patch\./,
		);

		assert.strictEqual(await runGit(repository, ['status', '--porcelain']), statusBefore);
		assert.strictEqual(await runGit(repository, ['rev-parse', 'HEAD']), headBefore);
		await assert.rejects(() => readdir(join(repository, '.patch-transfer')), { code: 'ENOENT' });
	});

	test('preserves the composer message when commit fails', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'commit-failure', 'base\n', 'initial history');
		await writeFile(join(repository, 'target.txt'), 'change before failed commit\n', 'utf8');
		const gitInputRepository = { inputBox: { value: 'fix: preserve this message' } };
		const messageManager = createMessageManager(gitInputRepository);
		const messageSession = await messageManager.beginCreatePatch();
		const patchService = new PatchService(new CommitFailingGitService());

		await assert.rejects(
			() => patchService.createPatch(repository, messageSession.message),
			/Commit failed: simulated commit failure/,
		);
		messageSession.complete(false);

		assert.strictEqual(gitInputRepository.inputBox.value, 'fix: preserve this message');
		assert.strictEqual(messageManager.getSnapshot().message, 'fix: preserve this message');
		assert.strictEqual(await runGit(repository, ['log', '-1', '--pretty=%s']), 'initial history');
		assert.strictEqual((await patchService.listPatches(repository))[0].status, 'CREATED');
	});

	test('copies exact bytes and detects same-SHA copies regardless of filename', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'copy-source', 'base\n', 'initial history');
		await writeFile(join(repository, 'target.txt'), 'copy me\n', 'utf8');
		const patchService = new PatchService(new GitService());
		const gitInputRepository = { inputBox: { value: 'feat: prepare offline copy' } };
		const messageManager = createMessageManager(gitInputRepository);
		const messageSession = await messageManager.beginCreatePatch();
		const createResult = await patchService.createPatch(repository, messageSession.message);
		assert.strictEqual(createResult.status, 'pushFailed');
		if (createResult.status !== 'pushFailed') {
			assert.fail('Expected patch creation without a remote to report pushFailed.');
		}
		messageSession.complete(true);
		assert.strictEqual(gitInputRepository.inputBox.value, '');
		assert.strictEqual((await patchService.listPatches(repository))[0].status, 'CREATED');
		const transferRepository = await createRepository(
			root,
			'copy-destination',
			'base\n',
			'independent destination history',
		);
		const transferDirectory = join(transferRepository, '.patch-transfer');
		await mkdir(transferDirectory, { recursive: true });
		const sourceBytes = await readFile(createResult.patchPath);

		const copied = await patchService.copyPatchToDirectory(
			createResult.patchPath,
			transferDirectory,
		);
		assert.strictEqual(copied.status, 'copied');
		if (copied.status !== 'copied') {
			assert.fail('Expected the first transfer copy to succeed.');
		}
		assert.strictEqual(copied.renamed, false);
		assert.deepStrictEqual(await readFile(createResult.patchPath), sourceBytes);
		assert.deepStrictEqual(
			await readFile(join(transferDirectory, createResult.patchName)),
			sourceBytes,
		);

		const sameNameDuplicate = await patchService.copyPatchToDirectory(
			createResult.patchPath,
			transferDirectory,
		);
		assert.strictEqual(sameNameDuplicate.status, 'alreadyExists');

		const differentlyNamedSourcePath = join(root, 'renamed-copy.patch');
		await copyFile(createResult.patchPath, differentlyNamedSourcePath);
		const differentNameDuplicate = await patchService.copyPatchToDirectory(
			differentlyNamedSourcePath,
			transferDirectory,
		);
		assert.strictEqual(differentNameDuplicate.status, 'alreadyExists');
		assert.deepStrictEqual(await readdir(transferDirectory), [createResult.patchName]);

		const collidingSourceDirectory = join(root, 'colliding-source');
		const collidingSourcePath = join(collidingSourceDirectory, createResult.patchName);
		const collidingBytes = Buffer.from('different patch bytes\n');
		await mkdir(collidingSourceDirectory, { recursive: true });
		await writeFile(collidingSourcePath, collidingBytes);
		const collidingSha256 = await new PatchStateService(new GitService())
			.calculatePatchSha256(collidingSourcePath);
		const collision = await patchService.copyPatchToDirectory(
			collidingSourcePath,
			transferDirectory,
		);
		assert.strictEqual(collision.status, 'copied');
		if (collision.status !== 'copied') {
			assert.fail('Expected different bytes under the same filename to be renamed.');
		}
		assert.strictEqual(
			collision.fileName,
			`${createResult.patchName.slice(0, -'.patch'.length)}_${collidingSha256.slice(0, 8)}.patch`,
		);
		assert.strictEqual(collision.renamed, true);
		assert.deepStrictEqual(
			await readFile(join(transferDirectory, createResult.patchName)),
			sourceBytes,
		);
		assert.deepStrictEqual(await readFile(collision.destinationPath), collidingBytes);
		assert.deepStrictEqual(await readFile(collidingSourcePath), collidingBytes);
		const destinationState = await new PatchStateService(new GitService()).load(
			transferRepository,
		);
		assert.deepStrictEqual(destinationState.created, {});
		assert.deepStrictEqual(destinationState.applied, {});
	});

	test('uses deterministic numeric fallback for Copy To and scans only the selected folder', async () => {
		const root = await createTemporaryDirectory();
		const sourceDirectory = join(root, 'source');
		const destinationDirectory = join(root, 'transfer');
		const patchName = 'update.patch';
		const sourcePath = join(sourceDirectory, patchName);
		const sourceBytes = Buffer.from([0, 10, 13, 255, 65, 66, 67]);
		await mkdir(sourceDirectory, { recursive: true });
		await mkdir(destinationDirectory, { recursive: true });
		await writeFile(sourcePath, sourceBytes);
		const stateService = new PatchStateService(new GitService());
		const sourceSha256 = await stateService.calculatePatchSha256(sourcePath);
		const generatedName = `update_${sourceSha256.slice(0, 8)}.patch`;
		const preferredPath = join(destinationDirectory, patchName);
		const generatedPath = join(destinationDirectory, generatedName);
		const preferredBytes = Buffer.from('occupied preferred name\n');
		const generatedBytes = Buffer.from('occupied generated name\n');
		await writeFile(preferredPath, preferredBytes);
		await writeFile(generatedPath, generatedBytes);

		const result = await new PatchService(new GitService()).copyPatchToDirectory(
			sourcePath,
			destinationDirectory,
		);
		assert.strictEqual(result.status, 'copied');
		if (result.status !== 'copied') {
			assert.fail('Expected a numeric fallback copy.');
		}
		assert.strictEqual(result.fileName, `update_${sourceSha256.slice(0, 8)}_2.patch`);
		assert.deepStrictEqual(await readFile(result.destinationPath), sourceBytes);
		assert.deepStrictEqual(await readFile(preferredPath), preferredBytes);
		assert.deepStrictEqual(await readFile(generatedPath), generatedBytes);

		const nestedDirectory = join(destinationDirectory, 'nested');
		const scopedDestination = join(root, 'scoped-transfer');
		await mkdir(nestedDirectory, { recursive: true });
		await mkdir(scopedDestination, { recursive: true });
		await copyFile(sourcePath, join(nestedDirectory, 'nested-duplicate.patch'));
		await mkdir(join(scopedDestination, 'nested'), { recursive: true });
		await copyFile(sourcePath, join(scopedDestination, 'nested', 'duplicate.patch'));
		const scopedResult = await new PatchService(new GitService()).copyPatchToDirectory(
			sourcePath,
			scopedDestination,
		);
		assert.strictEqual(scopedResult.status, 'copied');
	});

	test('imports a valid external copy locally without moving it or recording CREATED', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'import-source', 'base\n', 'source history');
		const destination = await createRepository(
			root,
			'import-destination',
			'base\n',
			'independent destination history',
			true,
		);
		const patchName = '2026-08-28_130000.patch';
		const sourcePatchPath = await createPatch(source, source, patchName, 'imported change\n');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = await stateService.calculatePatchSha256(sourcePatchPath);
		await stateService.recordCreated(source, sha256, patchName);
		const transferDirectory = join(root, 'transfer');
		await mkdir(transferDirectory, { recursive: true });
		const patchService = new PatchService(gitService);
		const copied = await patchService.copyPatchToDirectory(sourcePatchPath, transferDirectory);
		assert.strictEqual(copied.status, 'copied');
		if (copied.status !== 'copied') {
			assert.fail('Expected external transfer copy to succeed.');
		}
		const externalBytes = await readFile(copied.destinationPath);
		const statusBeforeImport = await runGit(destination, ['status', '--porcelain']);

		const imported = await patchService.importPatch(destination, copied.destinationPath);
		assert.strictEqual(imported.status, 'imported');
		if (imported.status !== 'imported') {
			assert.fail('Expected valid external patch import to succeed.');
		}
		assert.strictEqual(
			resolve(imported.patchPath),
			resolve(destination, '.patch-transfer', patchName),
		);
		assert.strictEqual(imported.renamed, false);
		assert.deepStrictEqual(await readFile(imported.patchPath), externalBytes);
		assert.deepStrictEqual(await readFile(copied.destinationPath), externalBytes);
		assert.deepStrictEqual((await stateService.load(destination)).created, {});
		assert.strictEqual((await patchService.listPatches(destination))[0].status, 'READY');
		assert.strictEqual(await runGit(destination, ['status', '--porcelain']), statusBeforeImport);
	});

	test('rejects invalid imports without copying or creating patch state', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'invalid-import', 'base\n', 'initial history');
		const externalDirectory = join(root, 'external');
		const externalPatchPath = join(externalDirectory, 'bad.patch');
		await mkdir(externalDirectory, { recursive: true });
		await writeFile(externalPatchPath, 'not a git patch\n', 'utf8');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const statusBeforeImport = await runGit(destination, ['status', '--porcelain']);

		const result = await patchService.importPatch(destination, externalPatchPath);
		assert.strictEqual(result.status, 'invalid');
		assert.strictEqual(await readFile(externalPatchPath, 'utf8'), 'not a git patch\n');
		await assert.rejects(() => readdir(join(destination, '.patch-transfer')), { code: 'ENOENT' });
		const statePath = await new PatchStateService(gitService).getStatePath(destination);
		await assert.rejects(() => readFile(statePath), { code: 'ENOENT' });
		assert.strictEqual(await runGit(destination, ['status', '--porcelain']), statusBeforeImport);
	});

	test('skips import duplicates with the same SHA under same or different filenames', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'duplicate-source', 'base\n', 'source history');
		const destination = await createRepository(
			root,
			'duplicate-destination',
			'base\n',
			'independent destination history',
			true,
		);
		const patchName = 'update.patch';
		const externalDirectory = join(root, 'external-duplicates');
		const externalPatchPath = await createPatch(
			source,
			externalDirectory,
			patchName,
			'imported change\n',
		);
		const projectPatchDirectory = join(destination, '.patch-transfer');
		const projectPatchPath = join(projectPatchDirectory, patchName);
		await mkdir(projectPatchDirectory, { recursive: true });
		await copyFile(externalPatchPath, projectPatchPath);
		const patchService = new PatchService(new GitService());

		const sameNameResult = await patchService.importPatch(destination, externalPatchPath);
		assert.strictEqual(sameNameResult.status, 'alreadyExists');
		assert.deepStrictEqual(await readdir(projectPatchDirectory), [patchName]);

		const differentNamePath = join(externalDirectory, 'renamed-external.patch');
		await copyFile(externalPatchPath, differentNamePath);
		const differentNameResult = await patchService.importPatch(destination, differentNamePath);
		assert.strictEqual(differentNameResult.status, 'alreadyExists');
		assert.deepStrictEqual(await readdir(projectPatchDirectory), [patchName]);
		const state = await new PatchStateService(new GitService()).load(destination);
		assert.deepStrictEqual(state.created, {});
		assert.deepStrictEqual(state.applied, {});
		assert.strictEqual((await patchService.listPatches(destination))[0].status, 'READY');
	});

	test('renames same-filename imports with a SHA suffix without overwriting', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'collision-source', 'base\n', 'source history');
		const destination = await createRepository(
			root,
			'collision-destination',
			'base\n',
			'destination history',
		);
		const patchName = '2026-08-28_140000.patch';
		const externalRoot = join(root, 'external-root');
		const externalPatchPath = await createPatch(source, externalRoot, patchName, 'external change\n');
		const projectPatchDirectory = join(destination, '.patch-transfer');
		const projectPatchPath = join(projectPatchDirectory, patchName);
		await mkdir(projectPatchDirectory, { recursive: true });
		const existingBytes = Buffer.from('existing project patch bytes\n');
		await writeFile(projectPatchPath, existingBytes);
		const externalBytes = await readFile(externalPatchPath);
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = await stateService.calculatePatchSha256(externalPatchPath);
		const patchService = new PatchService(gitService);

		const result = await patchService.importPatch(destination, externalPatchPath);
		assert.strictEqual(result.status, 'imported');
		if (result.status !== 'imported') {
			assert.fail('Expected a same-filename import to be renamed.');
		}
		assert.strictEqual(
			result.patchName,
			`2026-08-28_140000_${sha256.slice(0, 8)}.patch`,
		);
		assert.strictEqual(result.renamed, true);
		assert.deepStrictEqual(await readFile(projectPatchPath), existingBytes);
		assert.deepStrictEqual(await readFile(externalPatchPath), externalBytes);
		assert.deepStrictEqual(await readFile(result.patchPath), externalBytes);
		assert.deepStrictEqual((await stateService.load(destination)).created, {});
		assert.strictEqual(
			(await patchService.listPatches(destination)).find(patch => patch.name === result.patchName)?.status,
			'READY',
		);
	});

	test('handles occupied generated import names by SHA or deterministic numeric suffix', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'fallback-source', 'base\n', 'source history');
		const externalRoot = join(root, 'fallback-external');
		const externalPatchPath = await createPatch(
			source,
			externalRoot,
			'update.patch',
			'external change\n',
		);
		const externalBytes = await readFile(externalPatchPath);
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = await stateService.calculatePatchSha256(externalPatchPath);
		const generatedName = `update_${sha256.slice(0, 8)}.patch`;
		const patchService = new PatchService(gitService);

		const duplicateDestination = await createRepository(
			root,
			'generated-duplicate',
			'base\n',
			'destination history',
		);
		const duplicateDirectory = join(duplicateDestination, '.patch-transfer');
		await mkdir(duplicateDirectory, { recursive: true });
		await writeFile(join(duplicateDirectory, 'update.patch'), 'different preferred bytes\n');
		await copyFile(externalPatchPath, join(duplicateDirectory, generatedName));
		const duplicateResult = await patchService.importPatch(
			duplicateDestination,
			externalPatchPath,
		);
		assert.strictEqual(duplicateResult.status, 'alreadyExists');
		assert.ok(!(await readdir(duplicateDirectory)).includes(`update_${sha256.slice(0, 8)}_2.patch`));

		const fallbackDestination = await createRepository(
			root,
			'generated-fallback',
			'base\n',
			'destination history',
		);
		const fallbackDirectory = join(fallbackDestination, '.patch-transfer');
		const preferredPath = join(fallbackDirectory, 'update.patch');
		const generatedPath = join(fallbackDirectory, generatedName);
		const preferredBytes = Buffer.from('different preferred bytes\n');
		const generatedBytes = Buffer.from('different generated bytes\n');
		await mkdir(fallbackDirectory, { recursive: true });
		await writeFile(preferredPath, preferredBytes);
		await writeFile(generatedPath, generatedBytes);
		const fallbackResult = await patchService.importPatch(
			fallbackDestination,
			externalPatchPath,
		);
		assert.strictEqual(fallbackResult.status, 'imported');
		if (fallbackResult.status !== 'imported') {
			assert.fail('Expected a deterministic numeric import fallback.');
		}
		assert.strictEqual(fallbackResult.patchName, `update_${sha256.slice(0, 8)}_2.patch`);
		assert.deepStrictEqual(await readFile(fallbackResult.patchPath), externalBytes);
		assert.deepStrictEqual(await readFile(preferredPath), preferredBytes);
		assert.deepStrictEqual(await readFile(generatedPath), generatedBytes);
		const state = await stateService.load(fallbackDestination);
		assert.deepStrictEqual(state.created, {});
		assert.deepStrictEqual(state.applied, {});
	});

	test('loads old applied-only state and normalizes it on the next write', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'legacy-state', 'base\n', 'initial history');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const statePath = await stateService.getStatePath(repository);
		const appliedSha256 = 'a'.repeat(64);
		const appliedRecord = {
			fileName: 'legacy.patch',
			appliedAt: '2026-08-27T17:30:22.000Z',
		};
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(
			statePath,
			`${JSON.stringify({ version: 1, applied: { [appliedSha256]: appliedRecord } }, undefined, 2)}\n`,
			'utf8',
		);

		const legacyState = await stateService.load(repository);
		assert.deepStrictEqual(legacyState.created, {});
		assert.deepStrictEqual(legacyState.applied[appliedSha256], appliedRecord);

		const createdSha256 = 'b'.repeat(64);
		await stateService.recordCreated(repository, createdSha256, 'created.patch');
		const normalizedState = JSON.parse(await readFile(statePath, 'utf8')) as {
			created: Record<string, unknown>;
			applied: Record<string, unknown>;
		};
		assert.ok(normalizedState.created[createdSha256]);
		assert.deepStrictEqual(normalizedState.applied[appliedSha256], appliedRecord);
	});

	test('gives APPLIED precedence when the same SHA is also CREATED', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(
			source,
			destination,
			'2026-08-28_110000.patch',
			'changed\n',
		);
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = await stateService.calculatePatchSha256(patchPath);
		await stateService.recordCreated(destination, sha256, '2026-08-28_110000.patch');
		await stateService.recordApplied(destination, sha256, '2026-08-28_110000.patch');

		const patches = await new PatchService(gitService).listPatches(destination);
		assert.strictEqual(patches[0].status, 'APPLIED');
	});

	test('keeps CREATED repository-local when identical patch bytes are copied', async () => {
		const root = await createTemporaryDirectory();
		const repositoryA = await createRepository(root, 'repository-a', 'base\n', 'history A');
		const repositoryB = await createRepository(root, 'repository-b', 'base\n', 'history B', true);
		const patchName = '2026-08-28_120000.patch';
		const patchPathA = await createPatch(repositoryA, repositoryA, patchName, 'changed\n');
		const patchDirectoryB = join(repositoryB, '.patch-transfer');
		const patchPathB = join(patchDirectoryB, patchName);
		await mkdir(patchDirectoryB, { recursive: true });
		await copyFile(patchPathA, patchPathB);
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const sha256 = await stateService.calculatePatchSha256(patchPathA);
		await stateService.recordCreated(repositoryA, sha256, patchName);

		const patchService = new PatchService(gitService);
		assert.strictEqual((await patchService.listPatches(repositoryA))[0].status, 'CREATED');
		assert.strictEqual((await patchService.applyPatch(repositoryA, patchPathA)).status, 'created');
		assert.strictEqual((await patchService.listPatches(repositoryB))[0].status, 'READY');
		assert.strictEqual(await stateService.calculatePatchSha256(patchPathB), sha256);
	});

	test('adds the local Git exclude exactly once without touching the working tree', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'exclude-setup', 'base\n', 'initial history');
		const gitService = new GitService();
		const patchService = new PatchService(gitService);
		const excludePath = await gitService.getExcludePath(repository);
		await writeFile(excludePath, '# local excludes\r\n', 'utf8');

		await patchService.ensureRepositorySetup(repository);
		await patchService.ensureRepositorySetup(repository);

		const excludeContents = await readFile(excludePath, 'utf8');
		assert.strictEqual(
			excludeContents.split(/\r?\n/).filter(line => line.trim() === '.patch-transfer/').length,
			1,
		);
		assert.ok(excludeContents.endsWith('.patch-transfer/\r\n'));
		assert.strictEqual(await runGit(repository, ['status', '--porcelain']), '');
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

function createMessageManager(repository: { inputBox: { value: string } }): CommitMessageManager {
	return new CommitMessageManager(
		async () => ({ rootUri: 'test-repository', inputBox: repository.inputBox }),
		{
			getCommands: async () => [],
			executeCommand: async () => undefined,
		},
	);
}

class CommitFailingGitService extends GitService {
	override async commit(): Promise<void> {
		throw new Error('simulated commit failure');
	}
}
