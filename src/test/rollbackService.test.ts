import * as assert from 'assert';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { GitService } from '../gitService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import { RollbackService } from '../rollbackService';

const execFileAsync = promisify(execFile);

suite('Rollback and undo workflow', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('modified file: apply then undo restores exact original bytes', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'original content\n', 'source base');
		const destination = await createRepository(root, 'destination', 'original content\n', 'destination base');
		const patchPath = await createPatch(source, destination, '2026-08-30_100000.patch', 'modified content\n');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'modified content\n');

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		assert.ok(await rollbackService.hasSnapshot(destination, sha256));

		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'original content\n');

		const stateAfterUndo = await stateService.load(destination);
		assert.strictEqual(stateAfterUndo.applied[sha256], undefined);
	});

	test('added file: apply creates file, undo removes file', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Create a patch that adds a new file.
		await writeFile(join(source, 'added.txt'), 'new file content\n', 'utf8');
		await runGit(source, ['add', 'added.txt']);
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'add-file.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--cached', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'added.txt'), 'utf8'), 'new file content\n');

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		await assert.rejects(stat(join(destination, 'added.txt')), { code: 'ENOENT' });
	});

	test('deleted file: apply removes file, undo recreates exact bytes', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Add a file to delete in both repos.
		for (const repo of [source, destination]) {
			await writeFile(join(repo, 'deleteme.txt'), 'delete this file\n', 'utf8');
			await runGit(repo, ['add', '.']);
			await runGit(repo, ['commit', '--quiet', '-m', 'add deleteme']);
		}

		// Create a patch that deletes the file.
		await rm(join(source, 'deleteme.txt'));
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'delete-file.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		await assert.rejects(stat(join(destination, 'deleteme.txt')), { code: 'ENOENT' });

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		assert.strictEqual(await readFile(join(destination, 'deleteme.txt'), 'utf8'), 'delete this file\n');
	});

	test('binary file: bytes before apply, bytes after apply, undo restores exact original bytes', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Add a binary file to both repos.
		const originalBinary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02, 0xFF]);
		for (const repo of [source, destination]) {
			await writeFile(join(repo, 'image.bin'), originalBinary);
			await runGit(repo, ['add', '.']);
			await runGit(repo, ['commit', '--quiet', '-m', 'add binary']);
		}

		// Modify binary in source.
		const modifiedBinary = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0xAA, 0xBB, 0xCC, 0xDD]);
		await writeFile(join(source, 'image.bin'), modifiedBinary);
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'binary.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		assert.deepStrictEqual(await readFile(join(destination, 'image.bin')), modifiedBinary);

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		assert.deepStrictEqual(await readFile(join(destination, 'image.bin')), originalBinary);
	});

	test('rename: old/new paths snapshotted correctly, undo restores previous path state', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Add a file to rename in both repos.
		for (const repo of [source, destination]) {
			await writeFile(join(repo, 'old-name.txt'), 'rename me\n', 'utf8');
			await runGit(repo, ['add', '.']);
			await runGit(repo, ['commit', '--quiet', '-m', 'add old-name']);
		}

		// Rename in source.
		await runGit(source, ['mv', 'old-name.txt', 'new-name.txt']);
		await runGit(source, ['add', '--all']);
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'rename.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--cached', '--binary', '--full-index', '--no-color', '-M', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'new-name.txt'), 'utf8'), 'rename me\n');
		await assert.rejects(stat(join(destination, 'old-name.txt')), { code: 'ENOENT' });

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		assert.strictEqual(await readFile(join(destination, 'old-name.txt'), 'utf8'), 'rename me\n');
		await assert.rejects(stat(join(destination, 'new-name.txt')), { code: 'ENOENT' });
	});

	test('manual change after apply: detects fingerprint mismatch, cancel preserves, undo anyway restores', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'fingerprint.patch', 'patched\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Fingerprints should match immediately after apply.
		const noMismatches = await rollbackService.checkFingerprints(destination, sha256);
		assert.strictEqual(noMismatches.length, 0);

		// Manually change the file after apply.
		await writeFile(join(destination, 'target.txt'), 'manual edit\n', 'utf8');

		// Fingerprints should detect the mismatch.
		const mismatches = await rollbackService.checkFingerprints(destination, sha256);
		assert.strictEqual(mismatches.length, 1);
		assert.strictEqual(mismatches[0].path, 'target.txt');

		// Cancel: verify manual change is preserved.
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'manual edit\n');

		// Undo Anyway: restore original bytes.
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);

		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'base\n');
	});

	test('ordering: apply A then B, only B can be undone, after B undone A becomes candidate', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Create patch A.
		const patchPathA = await createPatch(source, destination, '2026-08-30_100000.patch', 'patch A\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		// Apply A.
		const resultA = await patchService.applyPatch(destination, patchPathA);
		assert.strictEqual(resultA.status, 'applied');
		const shaA = await stateService.calculatePatchSha256(patchPathA);

		// Create patch B (modifies a different file).
		await writeFile(join(source, 'other.txt'), 'patch B content\n', 'utf8');
		await runGit(source, ['add', 'other.txt']);
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPathB = join(patchDirectory, '2026-08-30_110000.patch');
		await runGit(source, [
			'diff', '--cached', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPathB}`,
		]);

		// Apply B.
		const resultB = await patchService.applyPatch(destination, patchPathB);
		assert.strictEqual(resultB.status, 'applied');
		const shaB = await stateService.calculatePatchSha256(patchPathB);

		// B is the latest applied.
		const latestSha = await stateService.getLatestAppliedSha(destination);
		assert.strictEqual(latestSha, shaB);

		// Undo B.
		await rollbackService.restoreSnapshot(destination, shaB);
		await stateService.removeApplied(destination, shaB);
		await rollbackService.deleteSnapshot(destination, shaB);

		// After undoing B, A is now the latest applied.
		const newLatestSha = await stateService.getLatestAppliedSha(destination);
		assert.strictEqual(newLatestSha, shaA);
		assert.ok(await rollbackService.hasSnapshot(destination, shaA));
	});

	test('successful undo removes APPLIED identity, failed undo does not', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'state-test.patch', 'changed\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Corrupt the backup manifest before restoring.
		const backupDir = await rollbackService.getBackupDirectory(destination, sha256);
		const manifestPath = join(backupDir, 'manifest.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		for (const entry of manifest.paths) {
			if (entry.beforeSha256) {
				entry.beforeSha256 = 'a'.repeat(64);
			}
		}
		await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2), 'utf8');

		// Undo should fail.
		await assert.rejects(() => rollbackService.restoreSnapshot(destination, sha256));

		// APPLIED state should NOT be removed on failure.
		const stateAfterFailedUndo = await stateService.load(destination);
		assert.ok(stateAfterFailedUndo.applied[sha256]);
	});

	test('failed patch application creates no finalized rollback snapshot', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'will-conflict.patch', 'patched\n');

		// Modify destination to cause conflict.
		await writeFile(join(destination, 'target.txt'), 'conflicting content\n', 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.ok(result.status === 'notReady' || result.status === 'applyFailed');

		const sha256 = await stateService.calculatePatchSha256(patchPath);
		assert.strictEqual(await rollbackService.hasSnapshot(destination, sha256), false);

		const stateAfterFail = await stateService.load(destination);
		assert.strictEqual(stateAfterFail.applied[sha256], undefined);
	});

	test('path safety: traversal paths are rejected', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		const mockGitService = new class extends GitService {
			override async getPatchNumStat(): Promise<string> {
				return '1\t1\t../../../etc/passwd';
			}
			override async getPatchSummary(): Promise<string> {
				return '';
			}
		}();

		const unsafeRollbackService = new RollbackService(mockGitService);
		const patchDirectory = join(destination, '.patch-transfer');
		await mkdir(patchDirectory, { recursive: true });
		const dummyPatchPath = join(patchDirectory, 'dummy.patch');
		await writeFile(dummyPatchPath, 'placeholder', 'utf8');

		await assert.rejects(
			() => unsafeRollbackService.resolveAffectedPaths(destination, dummyPatchPath),
			/Unsafe path detected/,
		);
	});

	test('snapshot cannot write outside repo or Git state area', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);

		// Verify backup directory resolves under .git/
		const backupDir = await rollbackService.getBackupDirectory(destination, 'a'.repeat(64));
		const gitDir = await gitService.getGitDirectory(destination);
		assert.ok(backupDir.startsWith(gitDir), `Backup dir ${backupDir} should be under ${gitDir}`);
	});

	test('transaction: simulated restore failure recovers pre-undo state', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'transaction.patch', 'changed\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'changed\n');

		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Corrupt backup data by removing a backed up file so restore fails.
		const backupDir = await rollbackService.getBackupDirectory(destination, sha256);
		const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
		for (const entry of manifest.paths) {
			if (entry.beforeSha256) {
				try {
					await unlink(join(backupDir, 'before', entry.beforeSha256));
				} catch {
					// May not exist.
				}
			}
		}

		// Attempt restore — should fail and recovery should restore the pre-undo state.
		await assert.rejects(() => rollbackService.restoreSnapshot(destination, sha256));

		// The file should still have the post-apply content (recovered).
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'changed\n');
	});

	test('CREATED behavior is unaffected by rollback system', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'created-repo', 'base\n', 'source history');
		await writeFile(join(repository, 'target.txt'), 'created change\n', 'utf8');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.createPatch(repository, 'feat: created patch');
		assert.ok(result.status === 'pushFailed' || result.status === 'success');

		const patches = await patchService.listPatches(repository);
		assert.strictEqual(patches[0].status, 'CREATED');
	});

	test('re-apply after undo generates fresh valid rollback snapshot', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'reapply.patch', 'applied\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		// Apply.
		const result1 = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result1.status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Undo.
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);
		await rollbackService.deleteSnapshot(destination, sha256);
		assert.strictEqual(await rollbackService.hasSnapshot(destination, sha256), false);
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'base\n');

		// Re-apply — should generate a fresh snapshot.
		const result2 = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result2.status, 'applied');
		assert.ok(await rollbackService.hasSnapshot(destination, sha256));

		// Verify the new snapshot works.
		const mismatches = await rollbackService.checkFingerprints(destination, sha256);
		assert.strictEqual(mismatches.length, 0);

		// Undo again.
		await rollbackService.restoreSnapshot(destination, sha256);
		assert.strictEqual(await readFile(join(destination, 'target.txt'), 'utf8'), 'base\n');
	});

	test('rollback manifest is valid JSON with correct structure', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'manifest-check.patch', 'changed\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'applied');
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		const backupDir = await rollbackService.getBackupDirectory(destination, sha256);
		const manifestContent = await readFile(join(backupDir, 'manifest.json'), 'utf8');
		const manifest = JSON.parse(manifestContent);

		assert.strictEqual(manifest.version, 1);
		assert.strictEqual(manifest.patchSha, sha256);
		assert.ok(manifest.appliedAt);
		assert.ok(Array.isArray(manifest.paths));
		assert.ok(manifest.paths.length > 0);

		for (const entry of manifest.paths) {
			assert.strictEqual(typeof entry.path, 'string');
			assert.strictEqual(typeof entry.beforeExists, 'boolean');
			assert.ok('afterExists' in entry);
			if (entry.beforeExists) {
				assert.match(entry.beforeSha256, /^[a-f0-9]{64}$/);
			}
			if (entry.afterExists) {
				assert.match(entry.afterSha256, /^[a-f0-9]{64}$/);
			}
		}
	});

	test('getLatestAppliedSha returns the most recently applied patch by timestamp', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);

		const shaA = 'a'.repeat(64);
		const shaB = 'b'.repeat(64);
		await stateService.recordApplied(destination, shaA, 'a.patch', new Date('2026-08-30T10:00:00Z'));
		await stateService.recordApplied(destination, shaB, 'b.patch', new Date('2026-08-30T11:00:00Z'));

		const latest = await stateService.getLatestAppliedSha(destination);
		assert.strictEqual(latest, shaB);
	});

	test('removeApplied is idempotent', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);

		const sha256 = 'a'.repeat(64);
		await stateService.recordApplied(destination, sha256, 'test.patch');

		let state = await stateService.load(destination);
		assert.ok(state.applied[sha256]);

		await stateService.removeApplied(destination, sha256);
		state = await stateService.load(destination);
		assert.strictEqual(state.applied[sha256], undefined);

		// Second removal should not throw.
		await stateService.removeApplied(destination, sha256);
		state = await stateService.load(destination);
		assert.strictEqual(state.applied[sha256], undefined);
	});

	test('hasSnapshot returns false for missing manifest', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);

		assert.strictEqual(
			await rollbackService.hasSnapshot(destination, 'nonexistent' + 'a'.repeat(55)),
			false,
		);
	});

	test('corrupted manifest is detected during restore', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'corrupt.patch', 'changed\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		await patchService.applyPatch(destination, patchPath);
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Corrupt the manifest.
		const backupDir = await rollbackService.getBackupDirectory(destination, sha256);
		await writeFile(join(backupDir, 'manifest.json'), '{ not valid json', 'utf8');

		await assert.rejects(
			() => rollbackService.restoreSnapshot(destination, sha256),
			/corrupted/i,
		);
	});

	test('cleanup removes rollback snapshot data', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'cleanup.patch', 'changed\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		await patchService.applyPatch(destination, patchPath);
		const sha256 = await stateService.calculatePatchSha256(patchPath);
		assert.ok(await rollbackService.hasSnapshot(destination, sha256));

		await rollbackService.deleteSnapshot(destination, sha256);
		assert.strictEqual(await rollbackService.hasSnapshot(destination, sha256), false);
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-rollback-test-'));
		temporaryDirectories.push(directory);
		return directory;
	}
});

async function createRepository(
	parent: string,
	name: string,
	targetContents: string,
	commitMessage: string,
): Promise<string> {
	const repository = join(parent, name);
	await mkdir(repository, { recursive: true });
	await runGit(repository, ['init', '--quiet']);
	await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
	await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
	await runGit(repository, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(repository, 'target.txt'), targetContents, 'utf8');
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
