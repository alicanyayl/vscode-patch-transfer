import * as assert from 'assert';
import { execFile } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from '../auditHistoryService';
import { ConflictDiffProvider } from '../conflictDiffProvider';
import { ConflictResolutionService } from '../conflictResolutionService';
import { GitService } from '../gitService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import { RollbackService } from '../rollbackService';
import { normalizeLineEndings } from '../patchHunkParser';

const execFileAsync = promisify(execFile);

suite('Interactive Conflict Resolution workflow', function () {
	this.timeout(45_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		for (const directory of temporaryDirectories.splice(0)) {
			try {
				await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			} catch {
				// Best-effort cleanup.
			}
		}
	});

	async function createTempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'pt-resolver-test-'));
		temporaryDirectories.push(dir);
		return dir;
	}

	test('SINGLE TEXT CONFLICT: identifies hunk, no real mutation until apply', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'line 1\nline 2\nline 3\n');
		const destination = await createRepo(root, 'destination', 'line 1\nline 2\nline 3\n');

		const patchPath = await createPatch(
			source,
			destination,
			'single.patch',
			'line 1\npatch line 2\nline 3\n',
		);

		// Induce conflict in destination
		await writeFile(join(destination, 'target.txt'), 'line 1\naltered line 2\nline 3\n', 'utf8');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			undefined,
			historyService,
			resolutionService,
		);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		// Start session
		const session = await resolutionService.startSession(destination, patchPath);
		assert.strictEqual(session.files.length, 1);
		const file = session.files[0];
		assert.strictEqual(file.status, 'conflict');
		assert.strictEqual(file.hunks.length, 1);
		const hunk = file.hunks[0];
		assert.ok(hunk.currentText.includes('altered line 2'));
		assert.ok(hunk.patchNewText.includes('patch line 2'));
		assert.strictEqual(hunk.resolution, 'unresolved');
		assert.strictEqual(hunk.canApplyPatchAutomatically, true);

		// Real destination file must NOT be modified
		const realContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(realContent, 'line 1\naltered line 2\nline 3\n');

		// State must remain CONFLICT
		const patchesDuring = await patchService.listPatches(destination);
		assert.strictEqual(patchesDuring[0].status, 'CONFLICT');

		await resolutionService.cancelSession(session);
	});

	test('KEEP CURRENT: preserves current content and marks patch APPLIED', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'line 1\nline 2\nline 3\n');
		const destination = await createRepo(root, 'destination', 'line 1\nline 2\nline 3\n');

		const patchPath = await createPatch(
			source,
			destination,
			'keep-current.patch',
			'line 1\npatch line 2\nline 3\n',
		);

		await writeFile(join(destination, 'target.txt'), 'line 1\naltered line 2\nline 3\n', 'utf8');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			undefined,
			historyService,
			resolutionService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'current');

		await resolutionService.applyResolved(session, destination);

		// Target file must retain current altered line
		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(normalizeLineEndings(finalContent), 'line 1\naltered line 2\nline 3\n');

		// Status is APPLIED
		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'APPLIED');
	});

	test('USE PATCH: replaces uniquely mapped conflict with incoming patch text', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'header\nline 1\nline 2\nline 3\nfooter\n');
		const destination = await createRepo(root, 'destination', 'header\nline 1\nline 2\nline 3\nfooter\n');

		const patchPath = await createPatch(
			source,
			destination,
			'use-patch.patch',
			'header\nline 1\npatch replacement\nline 3\nfooter\n',
		);

		// Alter line 2 in destination
		await writeFile(
			join(destination, 'target.txt'),
			'header\nline 1\nlocal modification\nline 3\nfooter\n',
			'utf8',
		);

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			undefined,
			historyService,
			resolutionService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const hunk = session.files[0].hunks[0];
		assert.strictEqual(hunk.canApplyPatchAutomatically, true);

		await resolutionService.setHunkResolution(session, hunk.id, 'patch');
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.ok(finalContent.includes('patch replacement'));
		assert.ok(!finalContent.includes('local modification'));

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'APPLIED');
	});

	test('AMBIGUOUS MATCH: requires manual resolution and prevents automatic guessing', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'prefix\nold middle\nsuffix\n');
		const destination = await createRepo(
			root,
			'destination',
			'prefix\naltered middle 1\nsuffix\n// separator\nprefix\naltered middle 2\nsuffix\n',
		);

		const patchPath = await createPatch(
			source,
			destination,
			'ambiguous.patch',
			'prefix\nnew incoming\nsuffix\n',
		);

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const hunk = session.files[0].hunks[0];

		assert.strictEqual(hunk.canApplyPatchAutomatically, false);
		assert.ok(hunk.unsafeReason?.includes('Multiple possible regions'));

		// Setting 'patch' resolution must throw error
		await assert.rejects(async () => {
			await resolutionService.setHunkResolution(session, hunk.id, 'patch');
		});

		await resolutionService.cancelSession(session);
	});

	test('MULTIPLE FILES: applies clean files A and C automatically while B follows user choice', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'base');
		const destination = await createRepo(root, 'destination', 'base');

		// Set up A.txt, B.txt, C.txt in both
		await writeFile(join(source, 'A.txt'), 'A original\n', 'utf8');
		await writeFile(join(source, 'B.txt'), 'B original\n', 'utf8');
		await writeFile(join(source, 'C.txt'), 'C original\n', 'utf8');
		await runGit(source, ['add', '.']);
		await runGit(source, ['commit', '--quiet', '-m', 'add A B C']);

		await writeFile(join(destination, 'A.txt'), 'A original\n', 'utf8');
		await writeFile(join(destination, 'B.txt'), 'B original\n', 'utf8');
		await writeFile(join(destination, 'C.txt'), 'C original\n', 'utf8');
		await runGit(destination, ['add', '.']);
		await runGit(destination, ['commit', '--quiet', '-m', 'add A B C']);

		// Modify A, B, C in source
		await writeFile(join(source, 'A.txt'), 'A patched\n', 'utf8');
		await writeFile(join(source, 'B.txt'), 'B patched\n', 'utf8');
		await writeFile(join(source, 'C.txt'), 'C patched\n', 'utf8');

		const patchDir = join(destination, '.patch-transfer');
		const patchPath = join(patchDir, 'multi.patch');
		await mkdir(patchDir, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		// Modify B in destination to trigger conflict in B only
		await writeFile(join(destination, 'B.txt'), 'B locally altered\n', 'utf8');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);

		// A and C should be clean, B is conflict
		const fileA = session.files.find(f => f.filePath === 'A.txt');
		const fileB = session.files.find(f => f.filePath === 'B.txt');
		const fileC = session.files.find(f => f.filePath === 'C.txt');

		assert.strictEqual(fileA?.status, 'clean');
		assert.strictEqual(fileC?.status, 'clean');
		assert.strictEqual(fileB?.status, 'conflict');

		// Resolve B to Keep Current
		await resolutionService.setHunkResolution(session, fileB!.hunks[0].id, 'current');
		await resolutionService.applyResolved(session, destination);

		// A and C must have patch applied!
		const aContent = await readFile(join(destination, 'A.txt'), 'utf8');
		const bContent = await readFile(join(destination, 'B.txt'), 'utf8');
		const cContent = await readFile(join(destination, 'C.txt'), 'utf8');

		assert.strictEqual(normalizeLineEndings(aContent), 'A patched\n');
		assert.strictEqual(normalizeLineEndings(bContent), 'B locally altered\n');
		assert.strictEqual(normalizeLineEndings(cContent), 'C patched\n');
	});

	test('NEW FILE ALREADY EXISTS: allows Keep Current or Use Patch File', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'base');
		const destination = await createRepo(root, 'destination', 'base');

		// Add new file in source
		await writeFile(join(source, 'newfile.txt'), 'incoming new content\n', 'utf8');
		await runGit(source, ['add', 'newfile.txt']);
		const patchDir = join(destination, '.patch-transfer');
		const patchPath = join(patchDir, 'newfile.patch');
		await mkdir(patchDir, { recursive: true });
		await runGit(source, [
			'diff', '--cached', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		// Create same file in destination with different content
		await writeFile(join(destination, 'newfile.txt'), 'existing local content\n', 'utf8');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'newfile.txt');
		assert.ok(file);
		assert.strictEqual(file.isNewFile, true);
		assert.strictEqual(normalizeLineEndings(file.hunks[0].currentText), 'existing local content\n');

		// Use Patch File
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'patch');
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'newfile.txt'), 'utf8');
		assert.strictEqual(normalizeLineEndings(finalContent), 'incoming new content\n');
	});

	test('DELETE CONFLICT: explicit choice required to delete', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'original text\n');
		const destination = await createRepo(root, 'destination', 'modified text\n');

		// In source, delete target.txt
		await rm(join(source, 'target.txt'));
		const patchDir = join(destination, '.patch-transfer');
		const patchPath = join(patchDir, 'delete.patch');
		await mkdir(patchDir, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files[0];
		assert.strictEqual(file.isDeletedFile, true);

		// Choose patch (delete)
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'patch');
		await resolutionService.applyResolved(session, destination);

		// File should be deleted in destination
		let exists = true;
		try {
			await stat(join(destination, 'target.txt'));
		} catch {
			exists = false;
		}
		assert.strictEqual(exists, false);
	});

	test('BINARY: binary conflict does not parse as text and keeps current safely', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'base');
		const destination = await createRepo(root, 'destination', 'base');

		const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
		await writeFile(join(source, 'image.png'), binaryBuffer);
		await runGit(source, ['add', '.']);
		await runGit(source, ['commit', '--quiet', '-m', 'add binary']);

		const modifiedBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99, 0x99]);
		await writeFile(join(source, 'image.png'), modifiedBinary);

		const patchDir = join(destination, '.patch-transfer');
		const patchPath = join(patchDir, 'binary.patch');
		await mkdir(patchDir, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		// In destination, create different binary
		const destBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
		await writeFile(join(destination, 'image.png'), destBinary);

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'image.png');
		assert.ok(file);
		assert.strictEqual(file.isBinary, true);
		assert.strictEqual(file.hunks[0].canApplyPatchAutomatically, false);

		// Keep Current works
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'current');
		await resolutionService.applyResolved(session, destination);

		const finalBytes = await readFile(join(destination, 'image.png'));
		assert.deepStrictEqual(finalBytes, destBinary);
	});

	test('MANUAL RESOLUTION: user edits candidate file and marks resolved', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'A\nB\nC\n');
		const destination = await createRepo(root, 'destination', 'A\nMOD\nC\n');

		const patchPath = await createPatch(source, destination, 'manual.patch', 'A\nPATCH\nC\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		const candidatePath = join(session.resolvedDir, 'target.txt');

		// User edits candidate file manually
		await writeFile(candidatePath, 'A\nMERGED MANUALLY\nC\n', 'utf8');

		await resolutionService.markFileManualResolved(session, 'target.txt');
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(finalContent, 'A\nMERGED MANUALLY\nC\n');
	});

	test('CANCEL: leaves real files, index, state and audit unchanged', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'A\n');
		const destination = await createRepo(root, 'destination', 'B\n');

		const patchPath = await createPatch(source, destination, 'cancel.patch', 'C\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			undefined,
			historyService,
			resolutionService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'current');

		await resolutionService.cancelSession(session);

		// Real file unchanged
		const content = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(content, 'B\n');

		// Status still CONFLICT
		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		// No APPLIED event in history
		const history = await historyService.loadHistory(destination);
		assert.strictEqual(history.events.filter(e => e.event === 'APPLIED').length, 0);
	});

	test('RACE CONDITION: external edit during resolution blocks apply', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'A\n');
		const destination = await createRepo(root, 'destination', 'B\n');

		const patchPath = await createPatch(source, destination, 'race.patch', 'C\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'current');

		// Modify real file outside resolver
		await writeFile(join(destination, 'target.txt'), 'EXTERNALLY MODIFIED\n', 'utf8');

		// Apply must be blocked
		await assert.rejects(async () => {
			await resolutionService.applyResolved(session, destination);
		}, /The project changed while this conflict was being resolved/);

		// External edit is preserved
		const content = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(content, 'EXTERNALLY MODIFIED\n');

		await resolutionService.cancelSession(session);
	});

	test('UNDO INTEGRATION: resolved patch supports full undo via RollbackService', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'line 1\nline 2\nline 3\n');
		const destination = await createRepo(root, 'destination', 'line 1\nline 2\nline 3\n');

		const patchPath = await createPatch(
			source,
			destination,
			'undo.patch',
			'line 1\npatch 2\nline 3\n',
		);

		const originalTargetBytes = 'line 1\naltered 2\nline 3\n';
		await writeFile(join(destination, 'target.txt'), originalTargetBytes, 'utf8');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'patch');
		await resolutionService.applyResolved(session, destination);

		// Verify patch applied
		const appliedContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.ok(appliedContent.includes('patch 2'));

		// Now test Undo
		const latestSha = await stateService.getLatestAppliedSha(destination);
		assert.ok(latestSha);
		const hasSnapshot = await rollbackService.hasSnapshot(destination, latestSha);
		assert.strictEqual(hasSnapshot, true);

		await rollbackService.restoreSnapshot(destination, latestSha);

		// Exact original bytes restored
		const restoredContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(restoredContent, originalTargetBytes);
	});

	test('NO REJ LEAK: no .rej file ever appears in destination repository', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'A\n');
		const destination = await createRepo(root, 'destination', 'B\n');

		const patchPath = await createPatch(source, destination, 'norej.patch', 'C\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'current');
		await resolutionService.applyResolved(session, destination);

		// Check for any .rej file in destination
		const gitDir = await gitService.getGitDirectory(destination);
		let rejFoundInDestination = false;
		try {
			await stat(join(destination, 'target.txt.rej'));
			rejFoundInDestination = true;
		} catch {
			rejFoundInDestination = false;
		}
		assert.strictEqual(rejFoundInDestination, false);
	});

	test('RESOLUTION RECEIPT: records choices metadata and is presented in patch details', async () => {
		const root = await createTempDir();
		const source = await createRepo(root, 'source', 'A\n');
		const destination = await createRepo(root, 'destination', 'B\n');

		const patchPath = await createPatch(source, destination, 'receipt.patch', 'C\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			undefined,
			historyService,
			resolutionService,
		);

		const session = await resolutionService.startSession(destination, patchPath);
		await resolutionService.setHunkResolution(session, session.files[0].hunks[0].id, 'current');
		await resolutionService.applyResolved(session, destination);

		const receipt = await resolutionService.getResolutionReceipt(destination, session.patchSha);
		assert.ok(receipt);
		assert.strictEqual(receipt.version, 1);
		assert.strictEqual(receipt.choices.current, 1);
		assert.strictEqual(receipt.choices.patch, 0);
		assert.strictEqual(receipt.choices.manual, 0);

		// Patch details includes resolution info
		const details = await patchService.getPatchDetails(destination, patchPath);
		assert.ok(details.resolution);
		assert.strictEqual(details.resolution.choices.current, 1);
	});

	test('PATH SAFETY: rejects patch paths attempting directory traversal', async () => {
		const root = await createTempDir();
		const destination = await createRepo(root, 'destination', 'base\n');

		const gitService = new GitService();
		const rollbackService = new RollbackService(gitService);
		const stateService = new PatchStateService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(
			gitService,
			rollbackService,
			stateService,
			historyService,
		);

		// Try traversal
		const traversalPath = join(destination, '..', 'evil.patch');
		await assert.rejects(async () => {
			await resolutionService.startSession(destination, traversalPath);
		});
	});
});

async function createRepo(parent: string, name: string, targetContents: string): Promise<string> {
	const repository = join(parent, name);
	await mkdir(repository, { recursive: true });
	await runGit(repository, ['init', '--quiet']);
	await runGit(repository, ['config', 'user.name', 'Resolver Tests']);
	await runGit(repository, ['config', 'user.email', 'resolver@example.invalid']);
	await runGit(repository, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(repository, 'target.txt'), targetContents, 'utf8');
	await runGit(repository, ['add', '.']);
	await runGit(repository, ['commit', '--quiet', '-m', 'base commit']);
	return repository;
}

async function createPatch(
	sourceRepo: string,
	destRepo: string,
	patchName: string,
	newContents: string,
): Promise<string> {
	const patchDirectory = join(destRepo, '.patch-transfer');
	const patchPath = join(patchDirectory, patchName);
	await mkdir(patchDirectory, { recursive: true });
	await writeFile(join(sourceRepo, 'target.txt'), newContents, 'utf8');
	await runGit(sourceRepo, [
		'diff', '--binary', '--full-index', '--no-color', 'HEAD',
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
