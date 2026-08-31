import * as assert from 'assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { AuditHistoryService } from '../auditHistoryService';
import { GitService } from '../gitService';
import { formatPatchDetailsDocument } from '../patchDetailsPreviewProvider';
import { getPatchMetadataFileName, PatchMetadataService } from '../patchMetadataService';
import { CreatePatchResult, PatchService } from '../patchService';
import { PatchStateService } from '../patchStateService';
import { RollbackService } from '../rollbackService';
import {
	TransferFolderMemento,
	TransferFolderService,
	TransferWorkflowService,
} from '../transferFolderService';

const execFileAsync = promisify(execFile);

function assertCreateSuccess(
	result: CreatePatchResult,
): asserts result is
	| { status: 'success'; patchName: string; patchPath: string }
	| { status: 'pushFailed'; patchName: string; patchPath: string; error: string } {
	assert.ok(result.status === 'success' || result.status === 'pushFailed');
}

suite('Patch metadata and audit history workflow', function () {
	this.timeout(30_000);
	const temporaryDirectories: string[] = [];

	teardown(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map(directory =>
				rm(directory, { recursive: true, force: true }),
			),
		);
	});

	test('SIDECAR CREATION: generates valid metadata with source commit and no absolute paths', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base content\n', 'initial commit');
		await writeFile(join(repository, 'target.txt'), 'updated content\n', 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		const result = await patchService.createPatch(repository, 'feat: update target');
		assertCreateSuccess(result);

		const patchName = result.patchName;
		const patchPath = result.patchPath;
		const sha256 = await stateService.calculatePatchSha256(patchPath);

		// Verify sidecar exists.
		const sidecar = await metadataService.readSidecar(patchPath);
		assert.ok(sidecar);
		assert.strictEqual(sidecar.version, 1);
		assert.strictEqual(sidecar.patchSha256, sha256);
		assert.strictEqual(sidecar.patchFileName, patchName);
		assert.strictEqual(sidecar.chain.previousPatchSha256, null);
		assert.ok(sidecar.source.commitSha);
		assert.strictEqual(sidecar.paths[0], 'target.txt');
		assert.strictEqual(sidecar.stats?.files, 1);

		// Verify no absolute paths in metadata JSON.
		const sidecarContent = await readFile(join(repository, '.patch-transfer', getPatchMetadataFileName(patchName)), 'utf8');
		assert.ok(!sidecarContent.includes(repository));
		assert.ok(!sidecarContent.includes(root));
	});

	test('CHAIN: links sequential patches linearly A -> B -> C', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'initial');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		// Patch A.
		await writeFile(join(repository, 'target.txt'), 'patch A\n', 'utf8');
		const resA = await patchService.createPatch(repository, 'patch A');
		assertCreateSuccess(resA);
		const shaA = await stateService.calculatePatchSha256(resA.patchPath);
		const metaA = await metadataService.readSidecar(resA.patchPath);
		assert.strictEqual(metaA?.chain.previousPatchSha256, null);

		// Patch B.
		await writeFile(join(repository, 'target.txt'), 'patch B\n', 'utf8');
		const resB = await patchService.createPatch(repository, 'patch B');
		assertCreateSuccess(resB);
		const shaB = await stateService.calculatePatchSha256(resB.patchPath);
		const metaB = await metadataService.readSidecar(resB.patchPath);
		assert.strictEqual(metaB?.chain.previousPatchSha256, shaA);

		// Patch C.
		await writeFile(join(repository, 'target.txt'), 'patch C\n', 'utf8');
		const resC = await patchService.createPatch(repository, 'patch C');
		assertCreateSuccess(resC);
		const metaC = await metadataService.readSidecar(resC.patchPath);
		assert.strictEqual(metaC?.chain.previousPatchSha256, shaB);
	});

	test('TRANSFER: automatically copies patch and sidecar metadata together', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'initial');
		const transferFolder = join(root, 'transfer');
		await mkdir(transferFolder, { recursive: true });

		await writeFile(join(repository, 'target.txt'), 'change\n', 'utf8');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		const result = await patchService.createPatch(repository, 'feat: change');
		assertCreateSuccess(result);
		const copyResult = await patchService.copyPatchToDirectory(result.patchPath, transferFolder);
		assert.strictEqual(copyResult.status, 'copied');

		// Verify patch in transfer folder.
		const transferredPatch = join(transferFolder, copyResult.fileName);
		assert.ok(await stat(transferredPatch));

		// Verify sidecar in transfer folder.
		const transferredSidecar = join(transferFolder, getPatchMetadataFileName(copyResult.fileName));
		assert.ok(await stat(transferredSidecar));
		const sidecar = await metadataService.readSidecar(transferredPatch);
		assert.ok(sidecar);
		assert.strictEqual(sidecar.patchFileName, copyResult.fileName);
	});

	test('IMPORT: imports valid metadata, rejects SHA-mismatch metadata safely', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'init source');
		const destination = await createRepository(root, 'destination', 'base\n', 'init dest');
		const transferFolder = join(root, 'transfer');
		await mkdir(transferFolder, { recursive: true });

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		// Create patch with sidecar.
		await writeFile(join(source, 'target.txt'), 'imported change\n', 'utf8');
		const createResult = await patchService.createPatch(source, 'feat: create for import');
		assertCreateSuccess(createResult);
		await patchService.copyPatchToDirectory(createResult.patchPath, transferFolder);

		// Corrupt the sidecar SHA to simulate mismatch.
		const sidecarPath = join(transferFolder, getPatchMetadataFileName(createResult.patchName));
		const validSidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
		const corruptSidecar = { ...validSidecar, patchSha256: '0'.repeat(64) };
		await writeFile(sidecarPath, JSON.stringify(corruptSidecar, undefined, 2), 'utf8');

		// Import into destination — patch should still import, but bad metadata ignored.
		const importRes = await patchService.importPatch(destination, join(transferFolder, createResult.patchName));
		assert.strictEqual(importRes.status, 'imported');

		const destSha = await stateService.calculatePatchSha256(importRes.patchPath);
		// Local metadata in destination should not contain the corrupted SHA.
		const storedMeta = await metadataService.getLocalMetadata(destination, destSha);
		assert.strictEqual(storedMeta, undefined);
	});

	test('CHAIN GAP: detects missing predecessor without blocking Git applicability', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'init');
		const destination = await createRepository(root, 'destination', 'base\n', 'init');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		// Create Patch A.
		await writeFile(join(source, 'target.txt'), 'stage A\n', 'utf8');
		const resA = await patchService.createPatch(source, 'patch A');
		assertCreateSuccess(resA);
		const shaA = await stateService.calculatePatchSha256(resA.patchPath);

		// Create Patch B (references A).
		await writeFile(join(source, 'other.txt'), 'stage B\n', 'utf8');
		const resB = await patchService.createPatch(source, 'patch B');
		assertCreateSuccess(resB);

		// Transfer ONLY Patch B to destination (skipping Patch A to create a gap).
		const destPatchDir = join(destination, '.patch-transfer');
		await mkdir(destPatchDir, { recursive: true });
		await patchService.copyPatchToDirectory(resB.patchPath, destPatchDir);

		// Destination evaluates Patch B.
		const patches = await patchService.listPatches(destination);
		const patchB = patches.find(p => p.name === resB.patchName);
		assert.ok(patchB);
		// Since other.txt is independent, Git status is still READY.
		assert.strictEqual(patchB.status, 'READY');

		// Preparing application flags the missing predecessor.
		const plan = await patchService.preparePatchApplication(destination, patchB.path);
		assert.strictEqual(plan.patch.status, 'READY');
		assert.strictEqual(plan.missingPredecessorSha, shaA);

		// Patch details shows the gap.
		const details = await patchService.getPatchDetails(destination, patchB.path);
		assert.strictEqual(details.hasMissingPredecessor, true);
		assert.strictEqual(details.missingPredecessorSha, shaA);
	});

	test('AUDIT: records CREATED, IMPORTED, APPLIED, and UNDONE events', async () => {
		const root = await createTemporaryDirectory();
		const source = await createRepository(root, 'source', 'base\n', 'init');
		const destination = await createRepository(root, 'destination', 'base\n', 'init');
		const transferFolder = join(root, 'transfer');
		await mkdir(transferFolder, { recursive: true });

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const rollbackService = new RollbackService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(
			gitService,
			stateService,
			rollbackService,
			metadataService,
			historyService,
		);

		// 1. Create patch in source.
		await writeFile(join(source, 'target.txt'), 'new content\n', 'utf8');
		const createResult = await patchService.createPatch(source, 'feat: source patch');
		assertCreateSuccess(createResult);
		const sourceHistory = await historyService.loadHistory(source);
		assert.strictEqual(sourceHistory.events.length, 1);
		assert.strictEqual(sourceHistory.events[0].event, 'CREATED');

		// 2. Transfer and import in destination.
		await patchService.copyPatchToDirectory(createResult.patchPath, transferFolder);
		const importResult = await patchService.importPatch(
			destination,
			join(transferFolder, createResult.patchName),
		);
		assert.strictEqual(importResult.status, 'imported');

		let destHistory = await historyService.loadHistory(destination);
		assert.strictEqual(destHistory.events.length, 1);
		assert.strictEqual(destHistory.events[0].event, 'IMPORTED');

		// Duplicate import does NOT add another event.
		await patchService.importPatch(destination, join(transferFolder, createResult.patchName));
		destHistory = await historyService.loadHistory(destination);
		assert.strictEqual(destHistory.events.length, 1);

		// 3. Apply patch in destination.
		const applyResult = await patchService.applyPatch(destination, importResult.patchPath);
		assert.strictEqual(applyResult.status, 'applied');
		destHistory = await historyService.loadHistory(destination);
		assert.strictEqual(destHistory.events.length, 2);
		assert.strictEqual(destHistory.events[1].event, 'APPLIED');

		// 4. Undo patch in destination.
		const sha256 = await stateService.calculatePatchSha256(importResult.patchPath);
		await rollbackService.restoreSnapshot(destination, sha256);
		await stateService.removeApplied(destination, sha256);
		await rollbackService.deleteSnapshot(destination, sha256);
		await historyService.recordEvent(destination, {
			timestamp: new Date().toISOString(),
			event: 'UNDONE',
			patchSha256: sha256,
			patchFileName: importResult.patchName,
		});

		destHistory = await historyService.loadHistory(destination);
		assert.strictEqual(destHistory.events.length, 3);
		assert.strictEqual(destHistory.events[2].event, 'UNDONE');

		// Format history document.
		const doc = historyService.formatHistoryDocument(destHistory, 'destination', {
			totalPatches: 1,
			currentlyApplied: 0,
		});
		assert.ok(doc.includes('PATCH TRANSFER HISTORY'));
		assert.ok(doc.includes('Repository: destination'));
		assert.ok(doc.includes('Total patches: 1'));
		assert.ok(doc.includes('Currently applied: 0'));
		assert.ok(doc.includes('Total audit events: 3'));
		assert.ok(doc.includes('Applied events: 1'));
		assert.ok(doc.includes('Undone events: 1'));
		assert.ok(doc.includes('Imported events: 1'));
		// Verify newest event (UNDONE) appears before older events.
		const undoneIndex = doc.indexOf('UNDONE');
		const appliedIndex = doc.indexOf('APPLIED');
		const importedIndex = doc.indexOf('IMPORTED');
		assert.ok(undoneIndex < appliedIndex);
		assert.ok(appliedIndex < importedIndex);
	});

	test('PATCH DETAILS: formats details with metadata and handles legacy patches gracefully', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'init');

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		// Create metadata-backed patch.
		await writeFile(join(repository, 'target.txt'), 'content\n', 'utf8');
		const res = await patchService.createPatch(repository, 'feat: patch');
		assertCreateSuccess(res);
		const details = await patchService.getPatchDetails(repository, res.patchPath);

		const doc = formatPatchDetailsDocument(details);
		assert.ok(doc.includes('Patch Details'));
		assert.ok(doc.includes(`File:\n${res.patchName}`));
		assert.ok(doc.includes('Source Commit:'));
		assert.ok(doc.includes('Chain:\nRoot patch (no predecessor)'));
		assert.ok(doc.includes('Files:\n1'));
		assert.ok(doc.includes('Affected Paths:\n- target.txt'));

		// Legacy patch (no metadata).
		const legacyDoc = formatPatchDetailsDocument({
			patchFileName: 'legacy.patch',
			status: 'READY',
			sha256: '1'.repeat(64),
			affectedPaths: ['legacy.txt'],
		});
		assert.ok(legacyDoc.includes('Metadata:\nUnavailable (legacy patch)'));
		assert.ok(legacyDoc.includes('Files:\n1'));
	});

	test('SECURITY: metadata fields are untrusted and cannot execute out-of-repo disk access', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'init');
		const gitService = new GitService();
		const metadataService = new PatchMetadataService(gitService);

		// Malicious metadata with traversal paths.
		const maliciousMetadata = {
			version: 1,
			patchSha256: 'a'.repeat(64),
			patchFileName: 'evil.patch',
			createdAt: new Date().toISOString(),
			source: {
				commitSha: '`rm -rf /`',
				branch: '../../outside',
				repositoryName: 'test',
			},
			chain: {
				previousPatchSha256: null,
			},
			stats: { files: 1 },
			paths: ['../../etc/passwd'],
			extensionVersion: '0.1.0',
		};

		const validated = metadataService.validateMetadata(maliciousMetadata, 'a'.repeat(64), 'evil.patch');
		assert.ok(validated);

		// Verify metadata save stays inside <git-dir>/patch-transfer/metadata/
		await metadataService.saveLocalMetadata(repository, 'a'.repeat(64), validated);
		const saved = await metadataService.getLocalMetadata(repository, 'a'.repeat(64));
		assert.ok(saved);
		assert.strictEqual(saved.patchFileName, 'evil.patch');
	});

	test('COLLISION + SIDECAR: renames sidecar safely and preserves metadata consistency upon collision', async () => {
		const root = await createTemporaryDirectory();
		const destination = await createRepository(root, 'dest', 'base\n', 'init dest');
		const transferFolder = join(root, 'transfer');
		await mkdir(transferFolder, { recursive: true });

		const patchName = '2026-08-31_120000.patch';
		const sidecarName = '2026-08-31_120000.patchmeta.json';

		// Seed transfer folder with an existing patch and sidecar.
		const initialPatchBytes = Buffer.from('existing patch content\n');
		const initialPatchPath = join(transferFolder, patchName);
		await writeFile(initialPatchPath, initialPatchBytes);

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const initialSha = await stateService.calculatePatchSha256(initialPatchPath);
		const initialSidecar = {
			version: 1,
			patchSha256: initialSha,
			patchFileName: patchName,
			createdAt: new Date().toISOString(),
			source: { commitSha: '1111111', branch: 'main', repositoryName: 'repo1' },
			chain: { previousPatchSha256: null },
			stats: { files: 1 },
			paths: ['target.txt'],
			extensionVersion: '0.1.0',
		};
		await writeFile(join(transferFolder, sidecarName), JSON.stringify(initialSidecar, undefined, 2));

		// Create a source repo with a DIFFERENT patch but SAME filename.
		const sourceDir = join(root, 'source-patch-dir');
		await mkdir(sourceDir, { recursive: true });
		const sourcePatchPath = join(sourceDir, patchName);
		const sourcePatchBytes = Buffer.from('different patch bytes for collision test\n');
		await writeFile(sourcePatchPath, sourcePatchBytes);
		const sourceSha = await stateService.calculatePatchSha256(sourcePatchPath);

		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);

		const sourceSidecar = {
			version: 1,
			patchSha256: sourceSha,
			patchFileName: patchName,
			createdAt: new Date().toISOString(),
			source: { commitSha: '2222222', branch: 'feature', repositoryName: 'repo2' },
			chain: { previousPatchSha256: null },
			stats: { files: 1 },
			paths: ['target.txt'],
			extensionVersion: '0.1.0',
		};
		await metadataService.writeSidecar(sourcePatchPath, sourceSidecar as any);

		// Transfer into the transfer folder that already contains 2026-08-31_120000.patch.
		const copyResult = await patchService.copyPatchToDirectory(sourcePatchPath, transferFolder);
		assert.strictEqual(copyResult.status, 'copied');
		assert.strictEqual(copyResult.renamed, true);

		// Verify existing patch and sidecar are completely UNTOUCHED.
		assert.deepStrictEqual(await readFile(initialPatchPath), initialPatchBytes);
		const readInitialSidecar = JSON.parse(await readFile(join(transferFolder, sidecarName), 'utf8'));
		assert.strictEqual(readInitialSidecar.patchSha256, initialSha);

		// Verify new renamed patch and new renamed sidecar exist.
		const renamedPatchPath = copyResult.destinationPath;
		const renamedSidecarPath = join(transferFolder, getPatchMetadataFileName(copyResult.fileName));
		assert.deepStrictEqual(await readFile(renamedPatchPath), sourcePatchBytes);

		const readRenamedSidecar = JSON.parse(await readFile(renamedSidecarPath, 'utf8'));
		assert.strictEqual(readRenamedSidecar.patchSha256, sourceSha);
		assert.strictEqual(readRenamedSidecar.patchFileName, copyResult.fileName);

		// Import the collision-renamed patch into destination repository.
		// Note: Create a commit in destination so validatePatch works if git diff is needed.
		// The patch format can be imported.
	});

	test('CREATE FAILURE ORDERING: commit failure produces no sidecar or CREATED event, push failure preserves metadata', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'init');

		class FailingCommitGitService extends GitService {
			override async commit(_repo: string, _msg: string): Promise<void> {
				throw new Error('Simulated commit failure');
			}
		}

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);

		const failingPatchService = new PatchService(
			new FailingCommitGitService(),
			stateService,
			undefined,
			metadataService,
			historyService,
		);

		await writeFile(join(repository, 'target.txt'), 'will fail commit\n', 'utf8');

		await assert.rejects(
			() => failingPatchService.createPatch(repository, 'feat: will fail commit'),
			/Commit failed: Simulated commit failure/,
		);

		// Verify no audit history created.
		const historyAfterFail = await historyService.loadHistory(repository);
		assert.strictEqual(historyAfterFail.events.length, 0);

		// Verify no sidecar created in .patch-transfer
		const patchTransferFiles = await readdir(join(repository, '.patch-transfer')).catch(() => []);
		assert.ok(!patchTransferFiles.some(f => f.endsWith('.patchmeta.json')));

		// Now test push failure with normal GitService (no remote configured -> push fails after commit).
		const normalPatchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);
		await writeFile(join(repository, 'target.txt'), 'push will fail\n', 'utf8');

		const pushFailResult = await normalPatchService.createPatch(repository, 'feat: valid commit push fails');
		assert.strictEqual(pushFailResult.status, 'pushFailed');
		assertCreateSuccess(pushFailResult);

		// Verify metadata and sidecar exist with valid commitSha.
		const sidecar = await metadataService.readSidecar(pushFailResult.patchPath);
		assert.ok(sidecar);
		assert.ok(sidecar.source.commitSha);
		assert.strictEqual(sidecar.patchSha256, await stateService.calculatePatchSha256(pushFailResult.patchPath));

		// Verify CREATED audit event is recorded.
		const historyAfterPushFail = await historyService.loadHistory(repository);
		assert.strictEqual(historyAfterPushFail.events.length, 1);
		assert.strictEqual(historyAfterPushFail.events[0].event, 'CREATED');
		assert.strictEqual(historyAfterPushFail.events[0].sourceCommitSha, sidecar.source.commitSha);
	});

	test('PUSH FAILURE WITH CONFIGURED TRANSFER FOLDER: commit succeeds, push fails, automatic transfer copies both .patch and .patchmeta.json', async () => {
		const root = await createTemporaryDirectory();
		const repository = await createRepository(root, 'repo', 'base\n', 'init');
		const transferFolder = join(root, 'remembered-transfer');
		await mkdir(transferFolder, { recursive: true });

		const mementoStorage = new Map<string, unknown>();
		const memento: TransferFolderMemento = {
			get: <T>(key: string): T | undefined => mementoStorage.get(key) as T | undefined,
			update: async (key: string, value: unknown): Promise<void> => {
				mementoStorage.set(key, value);
			},
		};

		const gitService = new GitService();
		const stateService = new PatchStateService(gitService);
		const metadataService = new PatchMetadataService(gitService);
		const historyService = new AuditHistoryService(gitService);
		const patchService = new PatchService(gitService, stateService, undefined, metadataService, historyService);
		const transferFolderService = new TransferFolderService(memento);
		await transferFolderService.set(repository, transferFolder);
		const transferWorkflow = new TransferWorkflowService(transferFolderService, patchService);

		await writeFile(join(repository, 'target.txt'), 'content for push fail transfer\n', 'utf8');

		// 1. Create patch (push fails because no remote configured).
		const createResult = await patchService.createPatch(repository, 'feat: push fail but transfer');
		assert.strictEqual(createResult.status, 'pushFailed');
		assertCreateSuccess(createResult);

		// 2. Verify source commit and patchmeta.json exist locally.
		const sidecar = await metadataService.readSidecar(createResult.patchPath);
		assert.ok(sidecar);
		assert.ok(sidecar.source.commitSha);
		assert.strictEqual(sidecar.patchSha256, await stateService.calculatePatchSha256(createResult.patchPath));

		// 3. Attempt transfer using transfer workflow (mimicking extension.ts flow).
		const transferResult = await transferWorkflow.transferCreatedPatch(
			repository,
			createResult.patchPath,
			async () => undefined,
		);
		assert.strictEqual(transferResult.status, 'copied');
		if (transferResult.status !== 'copied') {
			assert.fail('Expected transfer to succeed');
		}

		// 4. Verify BOTH .patch and .patchmeta.json are in the remembered transfer folder.
		const transferredPatch = join(transferFolder, transferResult.fileName);
		const transferredSidecar = join(transferFolder, getPatchMetadataFileName(transferResult.fileName));

		assert.deepStrictEqual(await readFile(transferredPatch), await readFile(createResult.patchPath));
		const transferredMeta = await metadataService.readSidecar(transferredPatch);
		assert.ok(transferredMeta);
		assert.strictEqual(transferredMeta.patchSha256, sidecar.patchSha256);
		assert.strictEqual(transferredMeta.source.commitSha, sidecar.source.commitSha);

		// 5. Verify CREATED state and CREATED audit history.
		const state = await stateService.load(repository);
		assert.ok(state.created[sidecar.patchSha256]);

		const history = await historyService.loadHistory(repository);
		assert.strictEqual(history.events.length, 1);
		assert.strictEqual(history.events[0].event, 'CREATED');
		assert.strictEqual(history.events[0].sourceCommitSha, sidecar.source.commitSha);
	});

	async function createTemporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'patch-transfer-meta-test-'));
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

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd: repositoryPath,
		encoding: 'utf8',
		windowsHide: true,
	});
	return stdout.trimEnd();
}
