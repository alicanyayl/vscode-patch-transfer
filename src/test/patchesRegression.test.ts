import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from '../auditHistoryService';
import { ConflictResolutionService } from '../conflictResolutionService';
import { GitService } from '../gitService';
import { PatchFile, PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import { RollbackService } from '../rollbackService';
import {
	isPatchFile,
	isPatchTreeItem,
	PatchesTreeProvider,
	PatchTreeItem,
	resolveTargetPatch,
} from '../patchesTreeProvider';

const execFileAsync = promisify(execFile);

suite('Patches Tree Provider and Selection Regression Tests', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('1. imported valid patch appears immediately in Patches view/provider', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'dest', 'base\n', 'dest base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);
		const provider = new PatchesTreeProvider(gitService, patchService, stateService, rollbackService);

		// Create external patch in an external directory outside destination
		const externalDir = join(root, 'external-patches');
		await mkdir(externalDir, { recursive: true });
		const externalPatchPath = join(externalDir, '2026-09-07_120000.patch');
		await writeFile(join(source, 'target.txt'), 'imported content\n', 'utf8');
		await runGit(source, [
			'diff',
			'--binary',
			'--full-index',
			'--no-color',
			'HEAD',
			`--output=${externalPatchPath}`,
		]);

		// Import patch
		const importResult = await patchService.importPatch(destination, externalPatchPath);
		assert.strictEqual(importResult.status, 'imported');

		// Refresh provider
		await provider.refresh(destination);
		assert.strictEqual(provider.count, 1);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.ok(items[0] instanceof PatchTreeItem);
		const patchItem = items[0] as PatchTreeItem;
		assert.strictEqual(patchItem.patch.name, '2026-09-07_120000.patch');
		assert.strictEqual(patchItem.patch.status, 'READY');
	});

	test('2. direct valid .patch file with no metadata/state is still visible', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'source base');
		const destination = await createRepository(root, 'dest', 'base\n', 'dest base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);
		const provider = new PatchesTreeProvider(gitService, patchService, stateService, rollbackService);

		// Create patch directly under .patch-transfer without any sidecar or state
		await createPatch(
			source,
			destination,
			'direct.patch',
			'direct content\n',
		);

		// Refresh provider
		await provider.refresh(destination);
		assert.strictEqual(provider.count, 1);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.ok(items[0] instanceof PatchTreeItem);
		const patchItem = items[0] as PatchTreeItem;
		assert.strictEqual(patchItem.patch.name, 'direct.patch');
		assert.strictEqual(patchItem.patch.status, 'READY');
	});

	test('3. Git apply --check success always classifies READY', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'original text\n', 'initial');
		const destination = await createRepository(root, 'destination', 'original text\n', 'initial');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		await createPatch(source, destination, 'clean.patch', 'modified text\n');

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'READY');
	});

	test('4. line offset caused by imports above the target region remains READY', async () => {
		const root = await createTemporaryDirectory();
		const header = '// Header line 1\n// Header line 2\n// Header line 3\n// Header line 4\n';
		const func = 'function calc() {\n  return 10;\n}\n';
		const footer = '// Footer line 1\n// Footer line 2\n// Footer line 3\n';
		const baseContent = header + func + footer;
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		// Patch changes calc to return 20
		await createPatch(source, destination, 'offset.patch', header + 'function calc() {\n  return 20;\n}\n' + footer);

		// Destination adds imports above the header (shifting lines down)
		const offsetContent = 'import { a } from "./a";\nimport { b } from "./b";\n' + baseContent;
		await writeFile(join(destination, 'target.txt'), offsetContent, 'utf8');

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'READY');
	});

	test('5. unrelated changes elsewhere in same file remain READY', async () => {
		const root = await createTemporaryDirectory();
		const baseContent = 'function helper() {\n  return "old";\n}\n\n// Spacer lines\n// Spacer lines\n// Spacer lines\n\nfunction main() {\n  return 1;\n}\n';
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		// Patch changes main()
		const patchedContent = 'function helper() {\n  return "old";\n}\n\n// Spacer lines\n// Spacer lines\n// Spacer lines\n\nfunction main() {\n  return 2;\n}\n';
		await createPatch(source, destination, 'unrelated.patch', patchedContent);

		// Destination edits helper() elsewhere in the file
		const destinationContent = 'function helper() {\n  return "new-unrelated";\n}\n\n// Spacer lines\n// Spacer lines\n// Spacer lines\n\nfunction main() {\n  return 1;\n}\n';
		await writeFile(join(destination, 'target.txt'), destinationContent, 'utf8');

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'READY');
	});

	test('6. genuine changed target context becomes CONFLICT', async () => {
		const root = await createTemporaryDirectory();
		const baseContent = 'function target() {\n  return "initial";\n}\n';
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		// Patch expects target to return "patch"
		await createPatch(source, destination, 'conflict.patch', 'function target() {\n  return "patch";\n}\n');

		// Destination changed the same line to "conflicting"
		await writeFile(join(destination, 'target.txt'), 'function target() {\n  return "conflicting";\n}\n', 'utf8');

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'CONFLICT');
	});

	test('7. malformed patch becomes INVALID', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'content\n', 'base');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const patchDirectory = join(repository, '.patch-transfer');
		await mkdir(patchDirectory, { recursive: true });
		await writeFile(join(patchDirectory, 'malformed.patch'), 'this is not a valid patch file\nrandom junk', 'utf8');

		const patches = await patchService.listPatches(repository);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'INVALID');
	});

	test('8. patch with 20 hunks where 18 are clean and 2 conflict: resolver exposes exactly 2 decisions', async () => {
		const root = await createTemporaryDirectory();
		const buildContent = (modifier?: (index: number) => string) => {
			const lines: string[] = [];
			for (let i = 1; i <= 20; i++) {
				for (let c = 1; c <= 8; c++) {
					lines.push(`// Spacer before section ${i} line ${c}`);
				}
				lines.push(modifier ? modifier(i) : `const section_${i} = "base_${i}";`);
			}
			return lines.join('\n') + '\n';
		};

		const baseContent = buildContent();
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');

		// Patch changes all 20 sections
		const patchContent = buildContent(i => `const section_${i} = "patched_${i}";`);
		const patchPath = await createPatch(source, destination, 'twenty_hunks.patch', patchContent);

		// Destination modifies only section 5 and section 15 to cause conflicts
		const destContent = buildContent(i => {
			if (i === 5) {
				return 'const section_5 = "conflicting_5";';
			}
			if (i === 15) {
				return 'const section_15 = "conflicting_15";';
			}
			return `const section_${i} = "base_${i}";`;
		});
		await writeFile(join(destination, 'target.txt'), destContent, 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const conflictFiles = session.files.filter(f => f.status === 'conflict');
		assert.strictEqual(conflictFiles.length, 1);
		assert.strictEqual(conflictFiles[0].hunks.length, 2, 'Resolver must expose exactly 2 conflicting decisions, not 20');
	});

	test('9. clean A + conflict B + clean C: Keep Current on B produces A incoming, B current, C incoming', async () => {
		const root = await createTemporaryDirectory();
		const makeAbcContent = (valA: string, valB: string, valC: string) => {
			const lines: string[] = [];
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Top spacer ${i}`);
			}
			lines.push(`const A = "${valA}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Middle spacer 1 line ${i}`);
			}
			lines.push(`const B = "${valB}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Middle spacer 2 line ${i}`);
			}
			lines.push(`const C = "${valC}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Bottom spacer ${i}`);
			}
			return lines.join('\n') + '\n';
		};

		const baseContent = makeAbcContent('base_A', 'base_B', 'base_C');
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');

		const patchContent = makeAbcContent('incoming_A', 'incoming_B', 'incoming_C');
		const patchPath = await createPatch(source, destination, 'abc.patch', patchContent);

		// Destination changes B
		const destContent = makeAbcContent('base_A', 'current_B', 'base_C');
		await writeFile(join(destination, 'target.txt'), destContent, 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 1, 'Only B should be a conflict');

		// Choose Keep Current for B
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'current');
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.ok(finalContent.includes('const A = "incoming_A";'), 'Clean A must be incoming patch version');
		assert.ok(finalContent.includes('const B = "current_B";'), 'Conflicting B must remain current target version');
		assert.ok(finalContent.includes('const C = "incoming_C";'), 'Clean C must be incoming patch version');
	});

	test('10. clean A + conflict B + clean C: Use Patch on B produces all A/B/C incoming changes', async () => {
		const root = await createTemporaryDirectory();
		const makeAbcContent = (valA: string, valB: string, valC: string) => {
			const lines: string[] = [];
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Top spacer ${i}`);
			}
			lines.push(`const A = "${valA}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Middle spacer 1 line ${i}`);
			}
			lines.push(`const B = "${valB}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Middle spacer 2 line ${i}`);
			}
			lines.push(`const C = "${valC}";`);
			for (let i = 1; i <= 8; i++) {
				lines.push(`// Bottom spacer ${i}`);
			}
			return lines.join('\n') + '\n';
		};

		const baseContent = makeAbcContent('base_A', 'base_B', 'base_C');
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');

		const patchContent = makeAbcContent('incoming_A', 'incoming_B', 'incoming_C');
		const patchPath = await createPatch(source, destination, 'abc_use_patch.patch', patchContent);

		// Destination changes B
		const destContent = makeAbcContent('base_A', 'current_B', 'base_C');
		await writeFile(join(destination, 'target.txt'), destContent, 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 1);

		// Choose Use Patch for B
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'patch');
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.ok(finalContent.includes('const A = "incoming_A";'), 'Clean A must be incoming patch version');
		assert.ok(finalContent.includes('const B = "incoming_B";'), 'Resolved B must be incoming patch version');
		assert.ok(finalContent.includes('const C = "incoming_C";'), 'Clean C must be incoming patch version');
	});

	test('11. selected patch A + inline action patch B => B is used', () => {
		const patchA: PatchFile = {
			name: 'patchA.patch',
			path: '/repo/.patch-transfer/patchA.patch',
			timestamp: new Date(),
			status: 'READY',
		};
		const patchB: PatchFile = {
			name: 'patchB.patch',
			path: '/repo/.patch-transfer/patchB.patch',
			timestamp: new Date(),
			status: 'CONFLICT',
		};

		const itemA = new PatchTreeItem(patchA);
		const itemB = new PatchTreeItem(patchB);

		const resolved = resolveTargetPatch(itemB, itemA);
		assert.strictEqual(resolved?.name, 'patchB.patch');
		assert.strictEqual(resolved?.status, 'CONFLICT');
	});

	test('12. ambiguous conflicting hunk disables automatic Use Patch and requires manual editing', async () => {
		const root = await createTemporaryDirectory();
		// Duplicate identical lines causing ambiguous match
		const baseContent = 'duplicate line\nduplicate line\nduplicate line\n';
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', 'other line\nother line\nother line\n', 'base');
		const patchPath = await createPatch(source, destination, 'ambiguous.patch', 'duplicate line\npatched line\nduplicate line\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 1);
		const hunk = file.hunks[0];
		assert.strictEqual(hunk.canApplyPatchAutomatically, false);
		await assert.rejects(
			() => resolutionService.setHunkResolution(session, hunk.id, 'patch'),
			/manual resolution required|Cannot automatically apply patch change/i,
		);
	});

	test('13. imported patch refresh does not require VS Code reload', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'base');
		const destination = await createRepository(root, 'destination', 'base\n', 'base');

		const externalDir = join(root, 'ext');
		await mkdir(externalDir, { recursive: true });
		const extPatch = join(externalDir, 'reload_test.patch');
		await writeFile(join(source, 'target.txt'), 'reload content\n', 'utf8');
		await runGit(source, ['diff', '--output=' + extPatch, 'HEAD']);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);
		const provider = new PatchesTreeProvider(gitService, patchService, stateService, rollbackService);

		await provider.refresh(destination);
		assert.strictEqual(provider.count, 0);

		// Import patch
		await patchService.importPatch(destination, extPatch);

		// Refresh without reload
		await provider.refresh(destination);
		assert.strictEqual(provider.count, 1);
		assert.strictEqual(provider.getChildren()[0]?.label, 'reload_test.patch');
	});

	test('14. inline action operates on clicked patch even if another patch is selected', () => {
		const itemA = new PatchTreeItem({
			name: 'A.patch',
			path: '/repo/.patch-transfer/A.patch',
			status: 'READY',
			timestamp: new Date(),
		});
		const itemB = new PatchTreeItem({
			name: 'B.patch',
			path: '/repo/.patch-transfer/B.patch',
			status: 'CONFLICT',
			timestamp: new Date(),
		});

		// User clicked inline on B while A was selected
		const target = resolveTargetPatch(itemB, itemA);
		assert.strictEqual(target?.name, 'B.patch');

		// Command palette invocation (no argument) falls back to selected A
		const fallback = resolveTargetPatch(undefined, itemA);
		assert.strictEqual(fallback?.name, 'A.patch');

		// Neither argument nor selection
		const none = resolveTargetPatch(undefined, undefined);
		assert.strictEqual(none, undefined);
	});

	test('15. Resolve Conflicts command ID and Show Conflict Details command IDs exactly match their registered handlers', async () => {
		const packagePath = resolve(__dirname, '..', '..', 'package.json');
		const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
			activationEvents: string[];
			contributes: {
				commands: Array<{ command: string; title: string }>;
				menus: {
					'view/item/context': Array<{ command: string; when: string }>;
				};
			};
		};

		const resolveCommand = packageJson.contributes.commands.find(
			c => c.command === 'patch-transfer.resolveConflicts',
		);
		assert.ok(resolveCommand, 'patch-transfer.resolveConflicts must be declared in contributes.commands');

		const conflictDetailsCommand = packageJson.contributes.commands.find(
			c => c.command === 'patch-transfer.showConflictDetails',
		);
		assert.ok(conflictDetailsCommand, 'patch-transfer.showConflictDetails must be declared in contributes.commands');

		const inlineResolve = packageJson.contributes.menus['view/item/context'].find(
			m => m.command === 'patch-transfer.resolveConflicts',
		);
		assert.ok(inlineResolve, 'patch-transfer.resolveConflicts must be in view/item/context');
		assert.match(inlineResolve.when, /patchTransfer\.patch\.conflict/);

		const inlineDetails = packageJson.contributes.menus['view/item/context'].find(
			m => m.command === 'patch-transfer.showConflictDetails',
		);
		assert.ok(inlineDetails, 'patch-transfer.showConflictDetails must be in view/item/context');
		assert.match(inlineDetails.when, /patchTransfer\.patch\.conflict/);

		const extensionPath = resolve(__dirname, '..', '..', 'src', 'extension.ts');
		const extensionSource = await readFile(extensionPath, 'utf8');
		assert.ok(
			extensionSource.includes("registerCommand('patch-transfer.resolveConflicts'"),
			'extension.ts must register patch-transfer.resolveConflicts',
		);
		assert.ok(
			extensionSource.includes("registerCommand('patch-transfer.showConflictDetails'"),
			'extension.ts must register patch-transfer.showConflictDetails',
		);
	});

	test('16. type guards isPatchTreeItem and isPatchFile detect items correctly', () => {
		const dummyPatch: PatchFile = {
			name: 'test.patch',
			path: '/path/test.patch',
			status: 'READY',
			timestamp: new Date(),
		};
		const treeItem = new PatchTreeItem(dummyPatch);

		assert.strictEqual(isPatchTreeItem(treeItem), true);
		assert.strictEqual(isPatchTreeItem({ patch: dummyPatch }), true);
		assert.strictEqual(isPatchTreeItem(undefined), false);
		assert.strictEqual(isPatchTreeItem('string'), false);

		assert.strictEqual(isPatchFile(dummyPatch), true);
		assert.strictEqual(isPatchFile({ path: '/foo', status: 'READY' }), true);
		assert.strictEqual(isPatchFile(treeItem), false);
		assert.strictEqual(isPatchFile(undefined), false);
	});

	test('17. manually Git-applied patch outside extension is detected as APPLIED, not CONFLICT', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'original text\n', 'initial');
		const destination = await createRepository(root, 'destination', 'original text\n', 'initial');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const patchPath = await createPatch(source, destination, 'already_applied.patch', 'modified text\n');

		// Outside extension, apply using git apply directly
		await runGit(destination, ['apply', '--whitespace=nowarn', patchPath]);

		// Extension refresh / listPatches
		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'APPLIED', 'Manually applied patch must be classified as APPLIED, not CONFLICT');

		// Extension does not offer to re-apply
		const applyResult = await patchService.applyPatch(destination, patchPath);
		assert.strictEqual(applyResult.status, 'alreadyApplied');
	});

	test('18. genuine conflict is not falsely detected as already applied', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'original text\n', 'initial');
		const destination = await createRepository(root, 'destination', 'original text\n', 'initial');
		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const patchService = new PatchService(gitService, stateService, rollbackService);

		const patchPath = await createPatch(source, destination, 'genuine_conflict.patch', 'modified text\n');

		// Destination modified to a conflicting value (neither forward nor reverse check will succeed)
		await writeFile(join(destination, 'target.txt'), 'conflicting third text\n', 'utf8');

		const patches = await patchService.listPatches(destination);
		assert.strictEqual(patches.length, 1);
		assert.strictEqual(patches[0].status, 'CONFLICT', 'Genuine conflict must remain CONFLICT');
	});

	test('19. resolveTargetPatch handles array arguments, resourceUri objects, and selection fallback', () => {
		const patchA: PatchFile = {
			name: 'A.patch',
			path: '/repo/.patch-transfer/A.patch',
			status: 'READY',
			timestamp: new Date(),
		};
		const patchB: PatchFile = {
			name: 'B.patch',
			path: '/repo/.patch-transfer/B.patch',
			status: 'CONFLICT',
			timestamp: new Date(),
		};
		const itemA = new PatchTreeItem(patchA);
		const itemB = new PatchTreeItem(patchB);

		// Array argument passed by VS Code for inline action on B while A is selected
		const fromArray = resolveTargetPatch([itemB], itemA);
		assert.strictEqual(fromArray?.name, 'B.patch');

		// ResourceUri object argument
		const fromResourceUri = resolveTargetPatch({ resourceUri: { fsPath: patchB.path } }, itemA, () => patchB);
		assert.strictEqual(fromResourceUri?.name, 'B.patch');

		// Fallback to selected item when argument is undefined
		const fallback = resolveTargetPatch(undefined, itemB);
		assert.strictEqual(fallback?.name, 'B.patch');

		// Warning condition: neither argument nor selection
		const none = resolveTargetPatch(undefined, undefined);
		assert.strictEqual(none, undefined);
	});

	test('20. Edit Result -> Accept Edited Result -> conflict becomes resolved', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base text\n', 'base');
		const destination = await createRepository(root, 'destination', 'different target text\n', 'base');
		const patchPath = await createPatch(source, destination, 'manual_edit.patch', 'incoming patch text\n');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 1);
		assert.strictEqual(file.hunks[0].resolution, 'unresolved');

		// User edits result and clicks Accept Edited Result
		const editedResult = 'user custom desired result\n';
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'manual', editedResult);

		assert.strictEqual(file.hunks[0].resolution, 'manual');
		assert.strictEqual(file.hunks[0].customResultText, editedResult);

		// Candidate file on disk has the edited result
		const candidateContent = await readFile(join(session.resolvedDir, 'target.txt'), 'utf8');
		assert.strictEqual(candidateContent, editedResult);
	});

	test('21. edited result survives final Apply and clean changes are preserved', async () => {
		const root = await createTemporaryDirectory();
		const makeContent = (valA: string, valB: string) => {
			const lines: string[] = [];
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Top spacer ${i}`);
			}
			lines.push(`const A = "${valA}";`);
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Middle spacer ${i}`);
			}
			lines.push(`const B = "${valB}";`);
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Bottom spacer ${i}`);
			}
			return lines.join('\n') + '\n';
		};

		const baseContent = makeContent('base_A', 'base_B');
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');

		const patchContent = makeContent('incoming_A', 'incoming_B');
		const patchPath = await createPatch(source, destination, 'apply_manual.patch', patchContent);

		// Destination changes B (causing conflict on B only, while A is clean)
		const destContent = makeContent('base_A', 'current_conflicting_B');
		await writeFile(join(destination, 'target.txt'), destContent, 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 1);

		// Accept custom edited result on conflict B
		const customB = 'const B = "my_custom_merged_B";';
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'manual', customB);

		// Apply resolved session
		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		// Clean A must be incoming, and B must be custom edited result
		assert.ok(finalContent.includes('const A = "incoming_A";'), 'Clean change A must be preserved');
		assert.ok(finalContent.includes('const B = "my_custom_merged_B";'), 'Custom edited result for B must be applied');
	});

	test('22. resolving one conflict manually does not affect another conflict', async () => {
		const root = await createTemporaryDirectory();
		const makeContent = (valA: string, valB: string) => {
			const lines: string[] = [];
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Top spacer ${i}`);
			}
			lines.push(`const A = "${valA}";`);
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Middle spacer ${i}`);
			}
			lines.push(`const B = "${valB}";`);
			for (let i = 1; i <= 10; i++) {
				lines.push(`// Bottom spacer ${i}`);
			}
			return lines.join('\n') + '\n';
		};

		const baseContent = makeContent('base_A', 'base_B');
		const source = await createRepository(root, 'source', baseContent, 'base');
		const destination = await createRepository(root, 'destination', baseContent, 'base');

		const patchContent = makeContent('incoming_A', 'incoming_B');
		const patchPath = await createPatch(source, destination, 'two_conflicts.patch', patchContent);

		// Destination changes both A and B to create 2 conflicts
		const destContent = makeContent('target_A', 'target_B');
		await writeFile(join(destination, 'target.txt'), destContent, 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const resolutionService = new ConflictResolutionService(gitService, rollbackService, stateService, historyService);

		const session = await resolutionService.startSession(destination, patchPath);
		const file = session.files.find(f => f.filePath === 'target.txt');
		assert.ok(file);
		assert.strictEqual(file.hunks.length, 2, 'File must have 2 conflicts');

		// Conflict 1 (A): resolved manually
		await resolutionService.setHunkResolution(session, file.hunks[0].id, 'manual', 'const A = "custom_A";');

		// Conflict 2 (B): resolved by Keep Current
		await resolutionService.setHunkResolution(session, file.hunks[1].id, 'current');

		await resolutionService.applyResolved(session, destination);

		const finalContent = await readFile(join(destination, 'target.txt'), 'utf8');
		assert.ok(finalContent.includes('const A = "custom_A";'), 'Conflict 1 must have custom manual result');
		assert.ok(finalContent.includes('const B = "target_B";'), 'Conflict 2 must preserve current target');
	});


	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-reg-test-'));
		temporaryDirectories.push(directory);
		return directory;
	}

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
});
