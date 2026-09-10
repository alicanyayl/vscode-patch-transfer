import { relative } from 'path';
import * as vscode from 'vscode';
import { confirmOutOfOrderPatchApply } from './applyPatchUx';
import { ChangesViewModel } from './changesViewModel';
import { ChangesViewProvider } from './changesViewProvider';
import { CommitMessageManager, CommitMessageSession } from './commitMessageManager';
import { VsCodeGitRepositoryResolver } from './gitApi';
import {
	GitRepositoryContext,
	GitService,
	gitRequiredMessage,
	repositoryRequiredMessage,
} from './gitService';
import { AuditHistoryService } from './auditHistoryService';
import { ConflictPreviewProvider } from './conflictPreviewProvider';
import { formatConflictClipboardReport } from './conflictDiagnostics';
import { HistoryPreviewProvider } from './historyPreviewProvider';
import { PatchDetailsPreviewProvider } from './patchDetailsPreviewProvider';
import { getAuthoritativePackageVersion, PatchMetadataService } from './patchMetadataService';
import { CreatePatchResult, PatchFile, PatchService } from './patchService';
import { PatchPreviewProvider } from './patchPreviewProvider';
import {
	isPatchTreeItem,
	PatchesTreeProvider,
	PatchTreeItem,
	resolveTargetPatch,
} from './patchesTreeProvider';
import { PatchStateService } from './patchStateService';
import { RollbackService } from './rollbackService';
import { TransferFolderService, TransferWorkflowService } from './transferFolderService';
import { ConflictDiffProvider } from './conflictDiffProvider';
import { ConflictResolverPanel } from './conflictResolverPanel';
import {
	PatchTransferRepositoryContext,
	RepositoryChoice,
} from './repositoryContext';

const ignoredWatchDirectories = new Set([
	'.git',
	'.patch-transfer',
	'node_modules',
	'out',
	'dist',
]);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const gitService = new GitService();
	const gitRepositoryResolver = new VsCodeGitRepositoryResolver();
	const repositoryContext = new PatchTransferRepositoryContext(
		async () => {
			const repositoryPaths = [...await gitRepositoryResolver.getRepositoryPaths()];
			const workspaceContexts = await Promise.all(
				(vscode.workspace.workspaceFolders ?? []).map(folder =>
					gitService.getRepositoryContext(folder.uri.fsPath),
				),
			);
			for (const workspaceContext of workspaceContexts) {
				if (workspaceContext.status === 'repository') {
					repositoryPaths.push(workspaceContext.repositoryPath);
				}
			}
			return repositoryPaths;
		},
		() => vscode.window.activeTextEditor?.document.uri.fsPath,
	);
	const stateService = new PatchStateService(gitService);
	const auditHistoryService = new AuditHistoryService(gitService);
	const metadataService = new PatchMetadataService(gitService);
	const extensionVersion = context.extension?.packageJSON?.version ?? getAuthoritativePackageVersion();
	const patchService = new PatchService(
		gitService,
		stateService,
		undefined,
		metadataService,
		auditHistoryService,
		undefined,
		extensionVersion,
	);
	const rollbackService = new RollbackService(gitService);
	const patchServiceWithRollback = new PatchService(
		gitService,
		stateService,
		rollbackService,
		metadataService,
		auditHistoryService,
		undefined,
		extensionVersion,
	);
	const patchPreviewProvider = new PatchPreviewProvider();
	const conflictPreviewProvider = new ConflictPreviewProvider();
	const historyPreviewProvider = new HistoryPreviewProvider(auditHistoryService);
	const patchDetailsPreviewProvider = new PatchDetailsPreviewProvider();
	const conflictDiffProvider = new ConflictDiffProvider();
	const conflictResolutionService = patchServiceWithRollback.getResolutionService();
	const transferFolders = new TransferFolderService(gitService, context.workspaceState);
	const transferWorkflow = new TransferWorkflowService(transferFolders, patchService);
	const patchesProvider = new PatchesTreeProvider(gitService, patchService, stateService, rollbackService);
	const outputChannel = vscode.window.createOutputChannel('Patch Transfer');
	const repositorySetupErrors = new Map<string, string>();
	const commitMessageManager = new CommitMessageManager(
		async () => {
			const repositoryPath = repositoryContext.repositoryPath;
			if (!repositoryPath) {
				return undefined;
			}
			return gitRepositoryResolver.resolve(repositoryPath);
		},
		{
			getCommands: async () => vscode.commands.getCommands(true),
			executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
		},
	);
	const changesModel = new ChangesViewModel(
		gitService,
		() => repositoryContext.repositoryPath,
	);
	const changesViewProvider = new ChangesViewProvider(
		context.extensionUri,
		commitMessageManager,
		changesModel,
	);

	const ensureActiveRepositorySetup = async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const activeWorkspacePaths = new Set(workspaceFolders.map(folder => folder.uri.fsPath));
		for (const workspacePath of repositorySetupErrors.keys()) {
			if (!activeWorkspacePaths.has(workspacePath)) {
				repositorySetupErrors.delete(workspacePath);
			}
		}

		for (const workspaceFolder of workspaceFolders) {
			const workspacePath = workspaceFolder.uri.fsPath;
			try {
				await patchService.ensureRepositorySetup(workspacePath);
				const repositoryPath = await gitService.getRepositoryRoot(workspacePath);
				if (repositoryPath) {
					void conflictResolutionService.cleanupStaleSessions(repositoryPath);
				}
				repositorySetupErrors.delete(workspacePath);
			} catch (error) {
				const details = error instanceof Error ? error.message : String(error);
				const message = `Could not update the local Git exclude for ${workspaceFolder.name}: ${details}`;
				outputChannel.appendLine(`[Repository setup] ${message}`);
				if (message !== repositorySetupErrors.get(workspacePath)) {
					void vscode.window.showErrorMessage(`Patch Transfer: ${message}`);
				}
				repositorySetupErrors.set(workspacePath, message);
			}
		}
	};

	await ensureActiveRepositorySetup();
	await repositoryContext.refresh();
	await Promise.all([
		changesViewProvider.refreshChanges(),
		patchesProvider.refresh(repositoryContext.repositoryPath),
	]);

	const patchesView = vscode.window.createTreeView('patch-transfer.patches', {
		treeDataProvider: patchesProvider,
	});
	const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
	const patchWatcher = vscode.workspace.createFileSystemWatcher(
		'{**/.patch-transfer/*.patch,.patch-transfer/*.patch}',
	);
	let activeOperation: 'creating' | 'applying' | 'importing' | 'removing' | 'undoing' | undefined;
	let changesRefreshTimer: NodeJS.Timeout | undefined;
	let patchesRefreshTimer: NodeJS.Timeout | undefined;
	let lastPatchRefreshError: string | undefined;
	let selectedPatchItem: PatchTreeItem | undefined;

	const setActiveOperation = (
		operation: 'creating' | 'applying' | 'importing' | 'removing' | 'undoing' | undefined,
	) => {
		activeOperation = operation;
		changesViewProvider.setOperationBusy(operation !== undefined);
	};

	const updateBadges = () => {
		patchesView.badge = patchesProvider.count > 0
			? {
				value: patchesProvider.count,
				tooltip: `${patchesProvider.count} patch file${patchesProvider.count === 1 ? '' : 's'}`,
			}
			: undefined;
	};

	const refreshChanges = async () => {
		await changesViewProvider.refreshChanges();
	};

	const refreshPatches = async () => {
		await patchesProvider.refresh(repositoryContext.repositoryPath);
		updateBadges();
		reportPatchRefreshError();
	};

	const scheduleChangesRefresh = (uri?: vscode.Uri) => {
		if (uri && shouldIgnoreFileEvent(uri)) {
			return;
		}

		if (changesRefreshTimer) {
			clearTimeout(changesRefreshTimer);
		}

		changesRefreshTimer = setTimeout(() => {
			changesRefreshTimer = undefined;
			void refreshChanges();
		}, 400);
	};

	const schedulePatchesRefresh = () => {
		if (patchesRefreshTimer) {
			clearTimeout(patchesRefreshTimer);
		}

		patchesRefreshTimer = setTimeout(() => {
			patchesRefreshTimer = undefined;
			void refreshPatches();
		}, 300);
	};

	const handleFileEvent = (uri: vscode.Uri) => {
		if (!shouldIgnoreFileEvent(uri)) {
			scheduleChangesRefresh(uri);
		}
	};

	const handlePatchFileEvent = (uri: vscode.Uri) => {
		if (repositoryContext.isActiveLocalPatchFile(uri.fsPath)) {
			schedulePatchesRefresh();
		}
	};

	function reportPatchRefreshError(): void {
		const error = patchesProvider.errorMessage;
		if (error && error !== lastPatchRefreshError) {
			void vscode.window.showErrorMessage(error);
		}
		lastPatchRefreshError = error;
	}

	function getTargetPatch(argument?: unknown): PatchFile | undefined {
		return resolveTargetPatch(
			argument,
			patchesView.selection[0] ?? selectedPatchItem,
			path => patchesProvider.getCurrentPatch(path),
		);
	}

	function showPatchError(patchName: string, status: string, error: string): void {
		outputChannel.clear();
		outputChannel.appendLine(`${patchName} - ${status}`);
		outputChannel.appendLine('');
		outputChannel.appendLine(error);
		outputChannel.show(true);
	}

	async function openConflictDetailsForPatch(
		repositoryPath: string,
		patchPath: string,
	): Promise<void> {
		try {
			const diagnostic = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Diagnosing patch conflicts...',
					cancellable: false,
				},
				() => patchService.getConflictDiagnostics(repositoryPath, patchPath),
			);
			await conflictPreviewProvider.show(diagnostic);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Conflict diagnosis failed: ${message}`);
		}
	}

	async function pickTransferFolder(openLabel: string): Promise<string | undefined> {
		const selectedFolders = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel,
		});
		return selectedFolders?.[0]?.fsPath;
	}

	function showRepositoryRequirement(repositoryStatus: GitRepositoryContext): void {
		vscode.window.showErrorMessage(
			repositoryStatus.status === 'missingGit'
				? gitRequiredMessage
				: repositoryRequiredMessage,
		);
	}

	async function pickRepository(
		repositories: readonly RepositoryChoice[],
	): Promise<string | undefined> {
		const selected = await vscode.window.showQuickPick(
			repositories.map(repository => ({
				label: repository.name,
				description: repository.path,
				repositoryPath: repository.path,
			})),
			{
				placeHolder: 'Select the repository used by Patch Transfer',
				title: 'Select Patch Transfer Repository',
			},
		);
		return selected?.repositoryPath;
	}

	async function getActiveRepositoryPath(): Promise<string | undefined> {
		if (repositoryContext.repositoryPath) {
			return repositoryContext.repositoryPath;
		}

		const repositoryPath = await repositoryContext.refresh({
			promptIfAmbiguous: true,
			picker: pickRepository,
		});
		if (repositoryPath) {
			return repositoryPath;
		}

		// A cancelled ambiguous QuickPick is not a missing-repository error.
		if (repositoryContext.repositoryCount > 1) {
			return undefined;
		}

		let repositoryStatus: GitRepositoryContext = { status: 'notRepository' };
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const candidateStatus = await gitService.getRepositoryContext(folder.uri.fsPath);
			if (candidateStatus.status === 'missingGit') {
				repositoryStatus = candidateStatus;
				break;
			}
		}
		showRepositoryRequirement(repositoryStatus);
		return undefined;
	}

	function updateRepositoryPresentation(): void {
		patchesView.description = repositoryContext.displayName;
		void vscode.commands.executeCommand(
			'setContext',
			'patchTransfer.multipleRepositories',
			repositoryContext.repositoryCount > 1,
		);
	}

	async function refreshRepositoryViews(): Promise<void> {
		selectedPatchItem = undefined;
		updateRepositoryPresentation();
		await Promise.all([
			changesViewProvider.refreshRepository(),
			changesViewProvider.refreshChanges(),
			refreshPatches(),
		]);
	}

	async function handleRepositorySetChanged(): Promise<void> {
		await ensureActiveRepositorySetup();
		await repositoryContext.refresh();
		await refreshRepositoryViews();
	}

	function formatImportSummary(
		importedCount: number,
		alreadyExistsCount: number,
		invalidCount: number,
	): string {
		const messages = [
			importedCount > 0
				? `Imported ${importedCount} patch${importedCount === 1 ? '' : 'es'}.`
				: 'No new patches found.',
		];
		if (alreadyExistsCount > 0) {
			messages.push(
				`${alreadyExistsCount} patch${alreadyExistsCount === 1 ? '' : 'es'} already existed.`,
			);
		}
		if (invalidCount > 0) {
			messages.push(
				`${invalidCount} invalid patch${invalidCount === 1 ? '' : 'es'} skipped.`,
			);
		}
		return messages.join(' ');
	}

	updateBadges();
	updateRepositoryPresentation();
	reportPatchRefreshError();
	const gitRepositoryListeners = await gitRepositoryResolver.registerRepositoryListeners(() => {
		void handleRepositorySetChanged();
	});
	const repositoryContextListener = repositoryContext.onDidChange(
		updateRepositoryPresentation,
	);

	context.subscriptions.push(
		changesViewProvider,
		patchPreviewProvider,
		conflictPreviewProvider,
		historyPreviewProvider,
		patchDetailsPreviewProvider,
		conflictDiffProvider,
		PatchPreviewProvider.register(patchPreviewProvider),
		ConflictPreviewProvider.register(conflictPreviewProvider),
		HistoryPreviewProvider.register(historyPreviewProvider),
		PatchDetailsPreviewProvider.register(patchDetailsPreviewProvider),
		ConflictDiffProvider.register(conflictDiffProvider),
		vscode.window.registerWebviewViewProvider(
			'patch-transfer.changes',
			changesViewProvider,
		),
		...gitRepositoryListeners,
		repositoryContextListener,
		patchesView,
		outputChannel,
		vscode.commands.registerCommand('patch-transfer.selectRepository', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer operation is already running.',
				);
				return;
			}

			const repositoryPath = await repositoryContext.select(pickRepository);
			if (!repositoryPath) {
				if (repositoryContext.repositoryCount === 0) {
					showRepositoryRequirement({ status: 'notRepository' });
				}
				return;
			}

			await refreshRepositoryViews();
		}),
		vscode.commands.registerCommand('patch-transfer.openLocalPatchFolder', async () => {
			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			try {
				const patchDirectory = await patchService.ensureLocalPatchDirectory(repositoryPath);
				await vscode.commands.executeCommand(
					'revealFileInOS',
					vscode.Uri.file(patchDirectory),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Could not open Local Patch Folder: ${message}`);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.setTransferFolder', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const folderPath = await transferWorkflow.setTransferFolder(
				repositoryPath,
				() => pickTransferFolder('Set Transfer Folder'),
			);
			if (folderPath) {
				vscode.window.showInformationMessage(`Transfer folder set: ${folderPath}`);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.createPatch', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			setActiveOperation('creating');
			let createdPatch: Exclude<CreatePatchResult, { status: 'noChanges' }> | undefined;
			let commitMessageSession: CommitMessageSession | undefined;
			let commitSucceeded = false;
			let focusCommitComposer = false;
			try {
				commitMessageSession = await changesViewProvider.beginCreatePatch();
				if (!commitMessageSession.repositoryAvailable) {
					vscode.window.showErrorMessage(repositoryRequiredMessage);
					return;
				}

				const commitMessage = commitMessageSession.message.trim();
				if (!commitMessage) {
					vscode.window.showInformationMessage(
						'Enter a commit message before creating the patch.',
					);
					focusCommitComposer = true;
					return;
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Creating patch...',
						cancellable: false,
					},
					() => patchService.createPatch(repositoryPath, commitMessage),
				);

				if (result.status === 'noChanges') {
					vscode.window.showInformationMessage('No changes available to create a patch.');
				} else {
					createdPatch = result;
					commitSucceeded = true;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(message);
			} finally {
				if (commitMessageSession) {
					changesViewProvider.completeCreatePatch(
						commitMessageSession,
						commitSucceeded,
					);
				}
				try {
					await Promise.all([refreshChanges(), refreshPatches()]);
				} finally {
					setActiveOperation(undefined);
				}
				if (focusCommitComposer) {
					await changesViewProvider.focusCommitMessage();
				}
			}

			if (!createdPatch) {
				return;
			}

			let transferMessage = '';
			try {
				const transferResult = await transferWorkflow.transferCreatedPatch(
					repositoryPath,
					createdPatch.patchPath,
					() => pickTransferFolder('Use as Transfer Folder'),
				);
				if (transferResult.status === 'alreadyExists') {
					transferMessage = '\nPatch already exists in the transfer folder.';
				} else if (transferResult.status === 'copied') {
					transferMessage = transferResult.renamed
						? `\nCopied to the transfer folder as ${transferResult.fileName}.`
						: '\nCopied to the transfer folder.';
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(
					`Patch created, but automatic transfer failed: ${message}`,
				);
			}

			if (createdPatch.status === 'pushFailed') {
				vscode.window.showErrorMessage(
					`Patch created: ${createdPatch.patchName}\nCommit succeeded, but push failed: ${createdPatch.error}${transferMessage}`,
				);
			} else {
				vscode.window.showInformationMessage(
					`Patch created: ${createdPatch.patchName}\nCommit and push completed.${transferMessage}`,
				);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.importPatch', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			setActiveOperation('importing');
			let followUpCommand: 'patch-transfer.importPatchFile' | 'patch-transfer.setTransferFolder' | undefined;
			try {
				const folderImport = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Importing patches from transfer folder...',
						cancellable: false,
					},
					() => transferWorkflow.importAvailablePatches(
						repositoryPath,
						() => pickTransferFolder('Use as Transfer Folder'),
					),
				);
				if (folderImport.status === 'cancelled') {
					return;
				}

				await refreshPatches();
				for (const invalidPatch of folderImport.result.invalid) {
					outputChannel.appendLine(
						`[Import Patch] ${invalidPatch.patchName}: ${invalidPatch.error}`,
					);
				}
				const summary = formatImportSummary(
					folderImport.result.imported.length,
					folderImport.result.alreadyExists.length,
					folderImport.result.invalid.length,
				);
				if (folderImport.result.invalid.length > 0) {
					vscode.window.showWarningMessage(summary);
				} else {
					vscode.window.showInformationMessage(summary);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const actions = message.includes('Transfer folder is currently unavailable:')
					? ['Import Patch File...', 'Set Transfer Folder'] as const
					: [];
				const selectedAction = await vscode.window.showErrorMessage(
					`Patch import failed: ${message}`,
					...actions,
				);
				if (selectedAction === 'Import Patch File...') {
					followUpCommand = 'patch-transfer.importPatchFile';
				} else if (selectedAction === 'Set Transfer Folder') {
					followUpCommand = 'patch-transfer.setTransferFolder';
				}
			} finally {
				setActiveOperation(undefined);
			}

			if (followUpCommand) {
				await vscode.commands.executeCommand(followUpCommand);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.importPatchFile', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const selectedFiles = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				filters: { 'Patch files': ['patch'] },
				openLabel: 'Import Patch File',
				title: 'Import Patch File...',
			});
			if (!selectedFiles || selectedFiles.length === 0) {
				return;
			}

			setActiveOperation('importing');
			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Importing selected patch files...',
						cancellable: false,
					},
					() => patchService.importPatchFiles(
						repositoryPath,
						selectedFiles.map(uri => uri.fsPath),
					),
				);

				await refreshPatches();
				for (const invalidPatch of result.invalid) {
					outputChannel.appendLine(
						`[Import Patch File] ${invalidPatch.patchName}: ${invalidPatch.error}`,
					);
				}
				const summary = formatImportSummary(
					result.imported.length,
					result.alreadyExists.length,
					result.invalid.length,
				);
				if (result.invalid.length > 0) {
					vscode.window.showWarningMessage(summary);
				} else {
					vscode.window.showInformationMessage(summary);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Patch file import failed: ${message}`);
			} finally {
				setActiveOperation(undefined);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.removeLocalPatch', async (argument?: unknown) => {
			let operationStarted = false;
			try {
				if (activeOperation) {
					vscode.window.showInformationMessage(
						'Another Patch Transfer operation is already running.',
					);
					return;
				}

				const patch = getTargetPatch(argument);
				if (!patch) {
					vscode.window.showInformationMessage('Select a patch first.');
					return;
				}

				const repositoryPath = await getActiveRepositoryPath();
				if (!repositoryPath) {
					return;
				}

				const confirmation = await vscode.window.showWarningMessage(
					`Remove local patch "${patch.name}"?`,
					{
						modal: true,
						detail: 'This deletes the local patch artifact and sidecar only. Removing the local patch does NOT undo project changes.',
					},
					'Remove Local Patch',
					'Cancel',
				);
				if (confirmation !== 'Remove Local Patch') {
					return;
				}

				setActiveOperation('removing');
				operationStarted = true;
				await patchService.removeLocalPatch(repositoryPath, patch.path);
				await refreshPatches();
				vscode.window.showInformationMessage(`Removed local patch: ${patch.name}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[Remove Local Patch] ${message}`);
				vscode.window.showErrorMessage(`Could not remove local patch: ${message}`);
			} finally {
				if (operationStarted) {
					setActiveOperation(undefined);
				}
			}
		}),
		vscode.commands.registerCommand('patch-transfer.previewPatch', async (argument?: unknown) => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}
			if (patch.status === 'INVALID') {
				vscode.window.showInformationMessage('Select a valid patch to preview.');
				return;
			}

			try {
				const preview = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Preparing patch preview: ${patch.name}`,
						cancellable: false,
					},
					() => patchService.previewPatch(repositoryPath, patch.path),
				);
				await patchPreviewProvider.show(preview, patch.status);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Patch preview failed: ${message}`);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.applyPatch', async (argument?: unknown) => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			if (patch.status === 'APPLIED') {
				vscode.window.showInformationMessage('Patch has already been applied.');
				return;
			}
			if (patch.status !== 'READY') {
				vscode.window.showInformationMessage('Only a ready patch can be applied.');
				return;
			}

			setActiveOperation('applying');
			try {
				const plan = await patchService.preparePatchApplication(
					repositoryPath,
					patch.path,
				);

				if (plan.patch.status === 'APPLIED') {
					vscode.window.showInformationMessage('Patch has already been applied.');
					return;
				}
				if (plan.patch.status !== 'READY') {
					const error = plan.patch.error ?? 'Git could not validate the patch.';
					showPatchError(plan.patch.name, plan.patch.status, error);
					vscode.window.showErrorMessage(
						`Patch is ${plan.patch.status.toLowerCase()}: ${plan.patch.name}`,
					);
					return;
				}

				if (plan.olderUnappliedPatchName) {
					const shouldApply = await confirmOutOfOrderPatchApply(
						plan.olderUnappliedPatchName,
						async (message, options, ...actions) =>
							vscode.window.showWarningMessage(message, options, ...actions),
					);
					if (!shouldApply) {
						return;
					}
				}

				if (plan.missingPredecessorSha) {
					const selection = await vscode.window.showWarningMessage(
						'A previous patch in this transfer chain is missing.\n\nApplying this patch without its predecessor may produce an incomplete project state.',
						{ modal: true },
						'Apply Anyway',
						'Cancel',
					);
					if (selection !== 'Apply Anyway') {
						return;
					}
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Applying patch: ${plan.patch.name}`,
						cancellable: false,
					},
					() => patchServiceWithRollback.applyPatch(repositoryPath, plan.patch.path),
				);

				switch (result.status) {
					case 'applied':
						vscode.window.showInformationMessage(`Patch applied: ${result.patchName}`);
						break;
					case 'alreadyApplied':
						vscode.window.showInformationMessage('Patch has already been applied.');
						break;
					case 'created':
						vscode.window.showInformationMessage(
							'Patches created in this repository cannot be applied here.',
						);
						break;
					case 'notReady': {
						showPatchError(result.patchName, result.patchStatus, result.error);
						const actions = result.patchStatus === 'CONFLICT' ? ['Show Details'] : [];
						const selection = await vscode.window.showErrorMessage(
							`Patch is ${result.patchStatus.toLowerCase()}: ${result.patchName}`,
							...actions,
						);
						if (selection === 'Show Details') {
							await openConflictDetailsForPatch(repositoryPath, plan.patch.path);
						}
						break;
					}
					case 'applyFailed': {
						showPatchError(result.patchName, 'APPLY FAILED', result.error);
						const selection = await vscode.window.showErrorMessage(
							`Patch application failed: ${result.error}`,
							'Show Details',
						);
						if (selection === 'Show Details') {
							await openConflictDetailsForPatch(repositoryPath, plan.patch.path);
						}
						break;
					}
					case 'stateSaveFailed':
						showPatchError(result.patchName, 'STATE SAVE FAILED', result.error);
						vscode.window.showErrorMessage(
							`Patch was applied, but applied-state tracking could not be saved. ${result.error}`,
						);
						break;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(message);
			} finally {
				await Promise.all([refreshChanges(), refreshPatches()]);
				setActiveOperation(undefined);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.showPatchError', (argument?: unknown) => {
			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}
			if (
				(patch.status !== 'CONFLICT' && patch.status !== 'INVALID') ||
				!patch.error
			) {
				vscode.window.showInformationMessage('Select a conflicting or invalid patch.');
				return;
			}

			showPatchError(patch.name, patch.status, patch.error);
		}),
		vscode.commands.registerCommand('patch-transfer.showConflictDetails', async (argument?: unknown) => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}
			if (patch.status !== 'CONFLICT') {
				vscode.window.showInformationMessage('Select a conflicting patch to view conflict details.');
				return;
			}

			await openConflictDetailsForPatch(repositoryPath, patch.path);
		}),
		vscode.commands.registerCommand('patch-transfer.copyConflictDiagnostics', async (argument?: unknown) => {
			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}
			if (patch.status !== 'CONFLICT') {
				vscode.window.showInformationMessage('Select a conflicting patch to copy conflict diagnostics.');
				return;
			}

			try {
				const diagnostic = await patchService.getConflictDiagnostics(repositoryPath, patch.path);
				const report = formatConflictClipboardReport(diagnostic);
				await vscode.env.clipboard.writeText(report);
				vscode.window.showInformationMessage('Conflict diagnostics copied to clipboard.');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Could not copy conflict diagnostics: ${message}`);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.resolveConflicts', async (argument?: unknown) => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}
			if (patch.status !== 'CONFLICT') {
				vscode.window.showInformationMessage('Select a conflicting patch to resolve conflicts.');
				return;
			}

			try {
				await ConflictResolverPanel.show(
					context.extensionUri,
					repositoryPath,
					patch.path,
					conflictResolutionService,
					conflictDiffProvider,
					async () => {
						await Promise.all([refreshChanges(), refreshPatches()]);
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Could not start conflict resolver: ${message}`);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.undoLastPatch', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			setActiveOperation('undoing');
			try {
				const latestSha = await stateService.getLatestAppliedSha(repositoryPath);
				if (!latestSha) {
					vscode.window.showInformationMessage('No applied patch is available to undo.');
					return;
				}

				const hasSnapshot = await rollbackService.hasSnapshot(repositoryPath, latestSha);
				if (!hasSnapshot) {
					vscode.window.showErrorMessage('Rollback data for this patch is unavailable.');
					return;
				}

				const mismatches = await rollbackService.checkFingerprints(repositoryPath, latestSha);
				if (mismatches.length > 0) {
					const fileCount = mismatches.length;
					const fileLabel = fileCount === 1 ? '1 file' : `${fileCount} files`;
					const selection = await vscode.window.showWarningMessage(
						`${fileLabel} changed after this patch was applied.`,
						{
							modal: true,
							detail: 'Undoing the patch may overwrite newer local changes.',
						},
						'Undo Anyway',
						'Cancel',
					);

					if (selection !== 'Undo Anyway') {
						return;
					}
				}

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Undoing last applied patch...',
						cancellable: false,
					},
					async () => {
						await patchServiceWithRollback.undoPatch(repositoryPath, latestSha);
					},
				);

				vscode.window.showInformationMessage('Last applied patch has been undone.');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[Undo Patch] ${message}`);
				vscode.window.showErrorMessage(`Undo failed: ${message}`);
			} finally {
				await Promise.all([refreshChanges(), refreshPatches()]);
				setActiveOperation(undefined);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.showHistory', async () => {
			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const state = await stateService.load(repositoryPath);
			const patches = await patchService.listPatches(repositoryPath).catch(() => []);
			const history = await auditHistoryService.loadHistory(repositoryPath);
			await historyPreviewProvider.show(
				history,
				repositoryPath.split(/[\\/]/).pop(),
				{
					totalPatches: patches.length,
					currentlyApplied: Object.keys(state.applied).length,
				},
			);
		}),
		vscode.commands.registerCommand('patch-transfer.showPatchDetails', async (argument?: unknown) => {
			const repositoryPath = await getActiveRepositoryPath();
			if (!repositoryPath) {
				return;
			}

			const patch = getTargetPatch(argument);
			if (!patch) {
				vscode.window.showInformationMessage('Select a patch first.');
				return;
			}

			const details = await patchService.getPatchDetails(repositoryPath, patch.path);
			await patchDetailsPreviewProvider.show(details);
		}),
		vscode.commands.registerCommand('patch-transfer.refresh', async () => {
			if (await getActiveRepositoryPath()) {
				await refreshChanges();
			}
		}),
		vscode.commands.registerCommand('patch-transfer.refreshPatches', async () => {
			if (await getActiveRepositoryPath()) {
				await refreshPatches();
			}
		}),
		fileWatcher,
		fileWatcher.onDidCreate(handleFileEvent),
		fileWatcher.onDidChange(handleFileEvent),
		fileWatcher.onDidDelete(handleFileEvent),
		patchWatcher,
		patchWatcher.onDidCreate(handlePatchFileEvent),
		patchWatcher.onDidChange(handlePatchFileEvent),
		patchWatcher.onDidDelete(handlePatchFileEvent),
		patchesView.onDidChangeSelection(event => {
			const item = event.selection[0];
			selectedPatchItem = isPatchTreeItem(item) ? item : undefined;
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void handleRepositorySetChanged();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => {
			if (repositoryContext.repositoryPath) {
				return;
			}
			void (async () => {
				const selectedPath = await repositoryContext.refresh();
				if (selectedPath) {
					await refreshRepositoryViews();
				}
			})();
		}),
		{
			dispose: () => {
				if (changesRefreshTimer) {
					clearTimeout(changesRefreshTimer);
				}
				if (patchesRefreshTimer) {
					clearTimeout(patchesRefreshTimer);
				}
			},
		},
	);
}

function shouldIgnoreFileEvent(uri: vscode.Uri): boolean {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return true;
	}

	const relativePath = relative(workspaceFolder.uri.fsPath, uri.fsPath);
	return relativePath
		.split(/[\\/]/)
		.some(segment => ignoredWatchDirectories.has(segment));
}

export function deactivate() {}
