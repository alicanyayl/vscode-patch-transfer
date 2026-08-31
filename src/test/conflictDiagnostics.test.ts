import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
	formatConflictClipboardReport,
	formatConflictDetailsDocument,
	parseConflictDiagnostics,
} from '../conflictDiagnostics';
import { GitService } from '../gitService';
import { PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import { RollbackService } from '../rollbackService';

const execFileAsync = promisify(execFile);

suite('Conflict diagnostics workflow', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('CONTEXT MISMATCH: detects altered file, identifies affected path and line', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'line 1\nline 2\nline 3\n', 'source base');
		const destination = await createRepository(root, 'destination', 'line 1\nline 2\nline 3\n', 'destination base');
		const patchPath = await createPatch(
			source,
			destination,
			'mismatch.patch',
			'line 1\nmodified line 2\nline 3\n',
		);

		// Modify destination file so it no longer matches the patch base.
		await writeFile(join(destination, 'target.txt'), 'line 1\naltered line 2\nline 3\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.strictEqual(diagnostic.patchFileName, 'mismatch.patch');
		assert.ok(diagnostic.files.length > 0);
		assert.strictEqual(diagnostic.files[0].path, 'target.txt');
		assert.strictEqual(diagnostic.files[0].reason, 'context-mismatch');
		assert.strictEqual(
			diagnostic.files[0].friendlyReason,
			'Current file contents differ from the version this patch expected.',
		);
		assert.ok(diagnostic.rawOutput.includes('patch failed') || diagnostic.rawOutput.includes('does not apply'));

		const doc = formatConflictDetailsDocument(diagnostic);
		assert.ok(doc.includes('Patch Conflict Details'));
		assert.ok(doc.includes('mismatch.patch'));
		assert.ok(doc.includes('STATUS\nCONFLICT'));
		assert.ok(doc.includes('target.txt'));
		assert.ok(doc.includes('Current file contents differ from the version this patch expected.'));
		assert.ok(doc.includes('WHAT THIS MEANS'));
		assert.ok(doc.includes('RAW GIT DIAGNOSTICS'));
	});

	test('MISSING FILE: detects expected file is missing in destination', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Add extra file to source and commit.
		await writeFile(join(source, 'extra.txt'), 'extra file content\n', 'utf8');
		await runGit(source, ['add', '.']);
		await runGit(source, ['commit', '--quiet', '-m', 'add extra']);

		// Modify extra.txt in source to produce a patch against extra.txt.
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'missing-file.patch');
		await mkdir(patchDirectory, { recursive: true });
		await writeFile(join(source, 'extra.txt'), 'modified extra content\n', 'utf8');
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.ok(diagnostic.files.length > 0);
		assert.strictEqual(diagnostic.files[0].path, 'extra.txt');
		assert.strictEqual(diagnostic.files[0].reason, 'missing-file');
		assert.strictEqual(
			diagnostic.files[0].friendlyReason,
			'The patch expects this file to exist, but it is missing.',
		);
	});

	test('ALREADY EXISTS: detects file being added already exists in destination', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');

		// Create a patch that adds new-file.txt.
		await writeFile(join(source, 'new-file.txt'), 'brand new file\n', 'utf8');
		await runGit(source, ['add', 'new-file.txt']);
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'add-conflict.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--cached', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		// Create new-file.txt in destination to cause conflict.
		await writeFile(join(destination, 'new-file.txt'), 'existing incompatible file\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.ok(diagnostic.files.length > 0);
		assert.strictEqual(diagnostic.files[0].path, 'new-file.txt');
		assert.strictEqual(diagnostic.files[0].reason, 'already-exists');
		assert.strictEqual(
			diagnostic.files[0].friendlyReason,
			'The patch is trying to add a file that already exists.',
		);
	});

	test('MULTIPLE FILES: diagnoses multiple conflicting files in a single patch', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'file1\n', 'source base');
		const destination = await createRepository(root, 'destination', 'file1\n', 'destination base');

		// Add file2 to both repos.
		for (const repo of [source, destination]) {
			await writeFile(join(repo, 'file2.txt'), 'file2 base\n', 'utf8');
			await runGit(repo, ['add', '.']);
			await runGit(repo, ['commit', '--quiet', '-m', 'add file2']);
		}

		// Modify both files in source to create a multi-file patch.
		await writeFile(join(source, 'target.txt'), 'file1 modified\n', 'utf8');
		await writeFile(join(source, 'file2.txt'), 'file2 modified\n', 'utf8');
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'multi.patch');
		await mkdir(patchDirectory, { recursive: true });
		await runGit(source, [
			'diff', '--binary', '--full-index', '--no-color', 'HEAD',
			`--output=${patchPath}`,
		]);

		// Conflict both files in destination.
		await writeFile(join(destination, 'target.txt'), 'file1 conflict\n', 'utf8');
		await writeFile(join(destination, 'file2.txt'), 'file2 conflict\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.strictEqual(diagnostic.files.length, 2);
		const paths = diagnostic.files.map(f => f.path);
		assert.ok(paths.includes('target.txt'));
		assert.ok(paths.includes('file2.txt'));
	});

	test('RAW OUTPUT: preserves original Git output verbatim', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'raw.patch', 'modified\n');

		await writeFile(join(destination, 'target.txt'), 'conflict\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.ok(diagnostic.rawOutput.length > 0);
		assert.ok(diagnostic.rawOutput.toLowerCase().includes('error:'));
	});

	test('READ ONLY: diagnostic generation does not mutate repository files or state', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'readonly.patch', 'modified\n');

		await writeFile(join(destination, 'target.txt'), 'conflicting contents\n', 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const preContent = await readFile(join(destination, 'target.txt'), 'utf8');
		const preGitStatus = await runGit(destination, ['status', '--porcelain']);
		const preState = await stateService.load(destination);

		// Run diagnosis multiple times.
		const diag1 = await patchService.getConflictDiagnostics(destination, patchPath);
		const diag2 = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.strictEqual(diag1.files[0].path, diag2.files[0].path);

		// Verify working tree untouched.
		const postContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.strictEqual(postContent, preContent);

		// Verify git status untouched.
		const postGitStatus = await runGit(destination, ['status', '--porcelain']);
		assert.strictEqual(postGitStatus, preGitStatus);

		// Verify state untouched.
		const postState = await stateService.load(destination);
		assert.deepStrictEqual(postState, preState);

		// Verify no rollback snapshot created.
		const sha256 = await stateService.calculatePatchSha256(patchPath);
		assert.strictEqual(await rollbackService.hasSnapshot(destination, sha256), false);
	});

	test('REFRESH: transitions from CONFLICT to READY after manual file repair', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'repair.patch', 'patched\n');

		// Break destination.
		await writeFile(join(destination, 'target.txt'), 'conflict\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		let patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'CONFLICT');

		// Repair destination back to expected baseline.
		await writeFile(join(destination, 'target.txt'), 'base\n', 'utf8');

		// Re-evaluate.
		patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'READY');
	});

	test('COPY DIAGNOSTICS: formats concise clipboard report without machine info', () => {
		const rawOutput = 'error: patch failed: src/Profile.tsx:42\nerror: src/Profile.tsx: patch does not apply\nerror: src/helper.ts: No such file or directory';
		const diagnostic = parseConflictDiagnostics(
			rawOutput,
			'2026-08-31_104500.patch',
			'abc123def456',
		);

		const report = formatConflictClipboardReport(diagnostic);

		assert.ok(report.includes('Patch Transfer Conflict Report'));
		assert.ok(report.includes('Patch: 2026-08-31_104500.patch'));
		assert.ok(report.includes('SHA-256: abc123def456'));
		assert.ok(report.includes('src/Profile.tsx'));
		assert.ok(report.includes('- Context mismatch near line 42'));
		assert.ok(report.includes('src/helper.ts'));
		assert.ok(report.includes('- File missing'));
		assert.ok(report.includes('Git:\nerror: patch failed: src/Profile.tsx:42'));
		// Must not include machine path roots.
		assert.ok(!report.includes('C:\\'));
		assert.ok(!report.includes('/Users/'));
	});

	test('APPLY FAILURE: apply failure diagnostic is available and rollback state remains clean', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchPath = await createPatch(source, destination, 'apply-fail.patch', 'patched\n');

		// Cause a conflict so applyPatch fails with notReady/CONFLICT.
		await writeFile(join(destination, 'target.txt'), 'incompatible\n', 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const result = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(result.status, 'notReady');
		if (result.status === 'notReady') {
			assert.strictEqual(result.patchStatus, 'CONFLICT');
			assert.ok(result.error.length > 0);
		}

		// Rollback state must remain clean.
		const sha256 = await stateService.calculatePatchSha256(patchPath);
		assert.strictEqual(await rollbackService.hasSnapshot(destination, sha256), false);

		// Diagnostics are still accessible.
		const diagnostic = await patchService.getConflictDiagnostics(destination, patchPath);
		assert.strictEqual(diagnostic.files[0].path, 'target.txt');
		assert.strictEqual(diagnostic.files[0].reason, 'context-mismatch');
	});

	test('INVALID vs CONFLICT: malformed patch is INVALID, not CONFLICT', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'destination', 'base\n', 'destination base');
		const patchDirectory = join(destination, '.patch-transfer');
		const patchPath = join(patchDirectory, 'corrupt.patch');
		await mkdir(patchDirectory, { recursive: true });
		await writeFile(patchPath, 'not a valid diff header at all\n', 'utf8');

		const gitService = new GitService();
		const patchService = new PatchService(gitService);

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches[0].status, 'INVALID');
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-conflict-test-'));
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
