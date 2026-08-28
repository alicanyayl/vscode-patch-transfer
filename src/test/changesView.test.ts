import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { createChangeRow } from '../changesViewModel';
import {
	createCommitMessageWebviewMessage,
	createPatchCommand,
	getChangesViewCommand,
} from '../changesViewProvider';
import { GitService } from '../gitService';

const execFileAsync = promisify(execFile);

suite('Unified Changes view', function () {
	this.timeout(15_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('contributes only the Changes and Patches views', async () => {
		const packagePath = resolve(__dirname, '..', '..', 'package.json');
		const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
			contributes: { views: { 'patch-transfer': Array<{ id: string; name: string; type?: string }> } };
		};
		const views = packageJson.contributes.views['patch-transfer'];

		assert.deepStrictEqual(
			views.map(view => ({ id: view.id, name: view.name })),
			[
				{ id: 'patch-transfer.changes', name: 'Changes' },
				{ id: 'patch-transfer.patches', name: 'Patches' },
			],
		);
		assert.strictEqual(views[0].type, 'webview');
		assert.ok(!views.some(view => view.id.includes('commitComposer')));
	});

	test('maps the Ctrl+Enter/create message to the existing Create Patch command', () => {
		assert.strictEqual(
			getChangesViewCommand({ type: 'createPatch' }),
			createPatchCommand,
		);
	});

	test('maps a generated Git input value to the visible textarea message', () => {
		assert.deepStrictEqual(
			createCommitMessageWebviewMessage({
				repositoryAvailable: true,
				message: 'feat: generated message',
			}),
			{ type: 'setCommitMessage', value: 'feat: generated message' },
		);
	});

	test('produces Webview rows for modified, added, deleted, renamed, and untracked files', async () => {
		const repository = await createTemporaryRepository();
		await writeFile(join(repository, 'modified.txt'), 'modified\n', 'utf8');
		await rm(join(repository, 'deleted.txt'));
		await runGit(repository, ['mv', 'renamed-old.txt', 'renamed-new.txt']);
		await writeFile(join(repository, 'added.txt'), 'added\n', 'utf8');
		await runGit(repository, ['add', 'added.txt']);
		await writeFile(join(repository, 'untracked.txt'), 'untracked\n', 'utf8');

		const changes = await new GitService().getChanges(repository);
		assert.ok(changes);
		const rows = new Map((changes ?? []).map(change => {
			const row = createChangeRow(change);
			return [row.fileName, row];
		}));

		assert.strictEqual(rows.get('modified.txt')?.status, 'M');
		assert.strictEqual(rows.get('added.txt')?.status, 'A');
		assert.strictEqual(rows.get('deleted.txt')?.status, 'D');
		assert.strictEqual(rows.get('untracked.txt')?.status, '?');
		assert.strictEqual(rows.get('renamed-new.txt')?.status, 'R');
		assert.strictEqual(rows.get('renamed-new.txt')?.originalPath, 'renamed-old.txt');
	});

	async function createTemporaryRepository(): Promise<string> {
		const repository = await mkdtemp(join(tmpdir(), 'patch-transfer-changes-test-'));
		temporaryDirectories.push(repository);
		await runGit(repository, ['init', '--quiet']);
		await runGit(repository, ['config', 'user.name', 'Patch Transfer Tests']);
		await runGit(repository, ['config', 'user.email', 'patch-transfer@example.invalid']);
		await runGit(repository, ['config', 'core.autocrlf', 'false']);
		await Promise.all([
			writeFile(join(repository, 'modified.txt'), 'base\n', 'utf8'),
			writeFile(join(repository, 'deleted.txt'), 'base\n', 'utf8'),
			writeFile(join(repository, 'renamed-old.txt'), 'base\n', 'utf8'),
		]);
		await runGit(repository, ['add', '.']);
		await runGit(repository, ['commit', '--quiet', '-m', 'initial history']);
		return repository;
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
