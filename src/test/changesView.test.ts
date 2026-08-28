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
import { formatPatchPreview } from '../patchPreviewProvider';
import { PatchTreeItem } from '../patchesTreeProvider';

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
			version: string;
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
		assert.strictEqual(packageJson.version, '0.0.3');
	});

	test('contributes clear Preview and Apply actions only for appropriate patch states', async () => {
		const packagePath = resolve(__dirname, '..', '..', 'package.json');
		const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
			contributes: {
				commands: Array<{ command: string; title: string; icon?: string }>;
				menus: { 'view/item/context': Array<{ command: string; when: string; group: string }> };
			};
		};
		const applyCommand = packageJson.contributes.commands.find(
			item => item.command === 'patch-transfer.applyPatch',
		);
		const previewCommand = packageJson.contributes.commands.find(
			item => item.command === 'patch-transfer.previewPatch',
		);
		const applyMenu = packageJson.contributes.menus['view/item/context'].find(
			item => item.command === 'patch-transfer.applyPatch',
		);
		const previewMenu = packageJson.contributes.menus['view/item/context'].find(
			item => item.command === 'patch-transfer.previewPatch',
		);

		assert.strictEqual(applyCommand?.title, 'Apply this patch to the current project');
		assert.strictEqual(applyCommand?.icon, '$(play)');
		assert.ok(applyMenu?.when.includes('patchTransfer.patch.ready'));
		assert.ok(!applyMenu?.when.includes('patchTransfer.patch.applied'));
		assert.strictEqual(previewCommand?.title, 'Preview patch changes');
		assert.strictEqual(previewCommand?.icon, '$(eye)');
		for (const status of ['ready', 'conflict', 'created', 'applied']) {
			assert.ok(previewMenu?.when.includes(`patchTransfer.patch.${status}`));
		}
		assert.ok(!previewMenu?.when.includes('patchTransfer.patch.invalid'));
	});

	test('presents READY and APPLIED rows with clear native status feedback', () => {
		const ready = new PatchTreeItem({
			name: 'ready.patch',
			path: 'C:/repository/.patch-transfer/ready.patch',
			timestamp: new Date(0),
			status: 'READY',
		});
		const applied = new PatchTreeItem({
			name: 'applied.patch',
			path: 'C:/repository/.patch-transfer/applied.patch',
			timestamp: new Date(0),
			status: 'APPLIED',
		});

		assert.strictEqual(ready.description, 'READY');
		assert.ok(String(ready.tooltip).includes('Ready to apply to the current project.'));
		assert.strictEqual(applied.description, 'APPLIED ✓');
		assert.ok(String(applied.tooltip).includes('This patch has already been applied.'));
	});

	test('formats a readable native-text patch preview', () => {
		const preview = formatPatchPreview(
			{
				patchName: 'update.patch',
				files: [
					{
						path: 'src/components/Profile.tsx',
						changeType: 'Modified',
						additions: 12,
						deletions: 4,
					},
					{
						path: 'src/utils/newHelper.ts',
						changeType: 'Added',
						additions: 38,
						deletions: 0,
					},
				],
			},
			'READY',
		);

		assert.ok(preview.includes('Patch Preview\nupdate.patch'));
		assert.ok(preview.includes('Status: READY'));
		assert.ok(preview.includes('Modified'));
		assert.ok(preview.includes('src/components/Profile.tsx'));
		assert.ok(preview.includes('+12  -4'));
		assert.ok(preview.includes('Added'));
		assert.ok(preview.includes('src/utils/newHelper.ts'));
	});

	test('contributes Set Transfer Folder to both Patch Transfer view titles', async () => {
		const packagePath = resolve(__dirname, '..', '..', 'package.json');
		const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
			contributes: {
				commands: Array<{ command: string; icon?: string }>;
				menus: { 'view/title': Array<{ command: string; when: string }> };
			};
		};
		const command = packageJson.contributes.commands.find(
			item => item.command === 'patch-transfer.setTransferFolder',
		);
		const titleEntries = packageJson.contributes.menus['view/title'].filter(
			item => item.command === 'patch-transfer.setTransferFolder',
		);

		assert.strictEqual(command?.icon, '$(folder-opened)');
		assert.deepStrictEqual(
			titleEntries.map(item => item.when).sort(),
			[
				'view == patch-transfer.changes',
				'view == patch-transfer.patches',
			],
		);
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

	test('preserves filename, parent path, status, ordering, and open behavior for spaced rows', () => {
		const changes = [
			{ status: ' M', path: 'src/components/ComponentName.tsx' },
			{ status: ' D', path: 'src/legacy/oldHelper.ts' },
		].map(createChangeRow);

		assert.deepStrictEqual(changes.map(change => change.fileName), [
			'ComponentName.tsx',
			'oldHelper.ts',
		]);
		assert.strictEqual(changes[0].parentPath, 'src/components');
		assert.strictEqual(changes[0].status, 'M');
		assert.strictEqual(changes[0].openable, true);
		assert.strictEqual(changes[1].parentPath, 'src/legacy');
		assert.strictEqual(changes[1].status, 'D');
		assert.strictEqual(changes[1].openable, false);
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
