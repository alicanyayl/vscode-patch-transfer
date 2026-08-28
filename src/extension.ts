import { relative } from 'path';
import * as vscode from 'vscode';
import { ChangesViewModel } from './changesViewModel';
import { ChangesViewProvider } from './changesViewProvider';
import { CommitMessageManager, CommitMessageSession } from './commitMessageManager';
import { VsCodeGitRepositoryResolver } from './gitApi';
import { GitService } from './gitService';
import { CreatePatchResult, PatchService } from './patchService';
import { PatchesTreeProvider, PatchTreeItem } from './patchesTreeProvider';

const ignoredWatchDirectories = new Set([
	'.git',
	'.patch-transfer',
	'node_modules',
	'out',
	'dist',
]);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const gitService = new GitService();
	const patchService = new PatchService(gitService);
	const patchesProvider = new PatchesTreeProvider(gitService, patchService);
	const outputChannel = vscode.window.createOutputChannel('Patch Transfer');
	const repositorySetupErrors = new Map<string, string>();
	const gitRepositoryResolver = new VsCodeGitRepositoryResolver();
	const commitMessageManager = new CommitMessageManager(
		async () => {
			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspacePath) {
				return undefined;
			}

			const repositoryPath = await gitService.getRepositoryRoot(workspacePath);
			return repositoryPath
				? gitRepositoryResolver.resolve(repositoryPath)
				: undefined;
		},
		{
			getCommands: async () => vscode.commands.getCommands(true),
			executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
		},
	);
	const changesModel = new ChangesViewModel(
		gitService,
		() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
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
	await Promise.all([changesViewProvider.refreshChanges(), patchesProvider.refresh()]);

	const patchesView = vscode.window.createTreeView('patch-transfer.patches', {
		treeDataProvider: patchesProvider,
	});
	const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
	const patchWatcher = vscode.workspace.createFileSystemWatcher('**/.patch-transfer/*.patch');
	let activeOperation: 'creating' | 'applying' | 'importing' | undefined;
	let changesRefreshTimer: NodeJS.Timeout | undefined;
	let patchesRefreshTimer: NodeJS.Timeout | undefined;
	let lastPatchRefreshError: string | undefined;

	const setActiveOperation = (
		operation: 'creating' | 'applying' | 'importing' | undefined,
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
		await patchesProvider.refresh();
		updateBadges();
		updatePatchCommandContexts(patchesView.selection[0]);
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

	function updatePatchCommandContexts(selectedItem?: vscode.TreeItem): void {
		const selectedPatch = selectedItem instanceof PatchTreeItem
			? patchesProvider.getCurrentPatch(selectedItem.patch.path)
			: undefined;
		void vscode.commands.executeCommand(
			'setContext',
			'patchTransfer.patchReady',
			selectedPatch?.status === 'READY',
		);
		void vscode.commands.executeCommand(
			'setContext',
			'patchTransfer.patchHasError',
			selectedPatch?.status === 'CONFLICT' || selectedPatch?.status === 'INVALID',
		);
	}

	function reportPatchRefreshError(): void {
		const error = patchesProvider.errorMessage;
		if (error && error !== lastPatchRefreshError) {
			void vscode.window.showErrorMessage(error);
		}
		lastPatchRefreshError = error;
	}

	function getSelectedPatchItem(argument?: unknown): PatchTreeItem | undefined {
		if (argument instanceof PatchTreeItem) {
			return argument;
		}

		const selectedItem = patchesView.selection[0];
		return selectedItem instanceof PatchTreeItem ? selectedItem : undefined;
	}

	function showPatchError(patchName: string, status: string, error: string): void {
		outputChannel.clear();
		outputChannel.appendLine(`${patchName} - ${status}`);
		outputChannel.appendLine('');
		outputChannel.appendLine(error);
		outputChannel.show(true);
	}

	async function copyPatchToSelectedDirectory(patchPath: string): Promise<void> {
		const selectedFolders = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Copy Patch Here',
		});
		const selectedFolder = selectedFolders?.[0];
		if (!selectedFolder) {
			return;
		}

		try {
			const result = await patchService.copyPatchToDirectory(
				patchPath,
				selectedFolder.fsPath,
			);
			if (result.status === 'alreadyExists') {
				vscode.window.showInformationMessage(
					'This patch already exists in the selected folder.',
				);
				return;
			}

			vscode.window.showInformationMessage(
				result.renamed
					? `Patch copied as ${result.fileName}`
					: `Patch copied to ${selectedFolder.fsPath}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Patch copy failed: ${message}`);
		}
	}

	updateBadges();
	updatePatchCommandContexts();
	reportPatchRefreshError();
	const gitRepositoryListeners = await gitRepositoryResolver.registerRepositoryListeners(() => {
		void Promise.all([
			changesViewProvider.refreshRepository(),
			changesViewProvider.refreshChanges(),
		]);
	});

	context.subscriptions.push(
		changesViewProvider,
		vscode.window.registerWebviewViewProvider(
			'patch-transfer.changes',
			changesViewProvider,
		),
		...gitRepositoryListeners,
		patchesView,
		outputChannel,
		vscode.commands.registerCommand('patch-transfer.createPatch', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspacePath) {
				vscode.window.showErrorMessage('Git repository not found');
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
					vscode.window.showErrorMessage('Git repository not found');
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
					() => patchService.createPatch(workspacePath, commitMessage),
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

			const copyAction = createdPatch.status === 'pushFailed'
				? await vscode.window.showErrorMessage(
					`Patch created: ${createdPatch.patchName}\nCommit succeeded, but push failed: ${createdPatch.error}`,
					'Copy To...',
				)
				: await vscode.window.showInformationMessage(
					`Patch created: ${createdPatch.patchName}\nCommit and push completed.`,
					'Copy To...',
				);
			if (copyAction === 'Copy To...') {
				await copyPatchToSelectedDirectory(createdPatch.patchPath);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.importPatch', async () => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspacePath) {
				vscode.window.showErrorMessage('Git repository not found');
				return;
			}

			setActiveOperation('importing');
			try {
				const selectedFiles = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					openLabel: 'Import Patch',
					filters: { 'Patch files': ['patch'] },
				});
				const selectedFile = selectedFiles?.[0];
				if (!selectedFile) {
					return;
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Importing patch: ${selectedFile.path.split('/').pop() ?? selectedFile.path}`,
						cancellable: false,
					},
					() => patchService.importPatch(workspacePath, selectedFile.fsPath),
				);

				if (result.status === 'invalid') {
					outputChannel.appendLine(`[Import Patch] ${selectedFile.fsPath}: ${result.error}`);
					vscode.window.showErrorMessage('Invalid patch file.');
				} else if (result.status === 'alreadyExists') {
					await refreshPatches();
					vscode.window.showInformationMessage(
						'This patch already exists in the project.',
					);
				} else {
					await refreshPatches();
					vscode.window.showInformationMessage(
						result.renamed
							? `Patch imported as ${result.patchName}`
							: `Patch imported: ${result.patchName}`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Patch import failed: ${message}`);
			} finally {
				setActiveOperation(undefined);
			}
		}),
		vscode.commands.registerCommand('patch-transfer.applyPatch', async (argument?: unknown) => {
			if (activeOperation) {
				vscode.window.showInformationMessage(
					'Another Patch Transfer Git operation is already running.',
				);
				return;
			}

			const item = getSelectedPatchItem(argument);
			if (!item) {
				vscode.window.showInformationMessage('Select a ready patch to apply.');
				return;
			}

			const currentPatch = patchesProvider.getCurrentPatch(item.patch.path);
			if (currentPatch?.status === 'APPLIED') {
				vscode.window.showInformationMessage('Patch has already been applied.');
				return;
			}
			if (currentPatch?.status !== 'READY') {
				vscode.window.showInformationMessage('Only a ready patch can be applied.');
				return;
			}

			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspacePath) {
				vscode.window.showErrorMessage('Git repository not found');
				return;
			}

			setActiveOperation('applying');
			try {
				const repositoryPath = await gitService.getRepositoryRoot(workspacePath);
				if (!repositoryPath) {
					vscode.window.showErrorMessage('Git repository not found');
					return;
				}

				const plan = await patchService.preparePatchApplication(
					repositoryPath,
					currentPatch.path,
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
					const confirmation = await vscode.window.showWarningMessage(
						`An older unapplied patch exists:\n${plan.olderUnappliedPatchName}\n\nApply ${plan.patch.name} anyway?`,
						{ modal: true },
						'Apply Anyway',
					);
					if (confirmation !== 'Apply Anyway') {
						return;
					}
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Applying patch: ${plan.patch.name}`,
						cancellable: false,
					},
					() => patchService.applyPatch(repositoryPath, plan.patch.path),
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
					case 'notReady':
						showPatchError(result.patchName, result.patchStatus, result.error);
						vscode.window.showErrorMessage(
							`Patch is ${result.patchStatus.toLowerCase()}: ${result.patchName}`,
						);
						break;
					case 'applyFailed':
						showPatchError(result.patchName, 'APPLY FAILED', result.error);
						vscode.window.showErrorMessage(`Patch application failed: ${result.error}`);
						break;
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
			const item = getSelectedPatchItem(argument);
			const patch = item ? patchesProvider.getCurrentPatch(item.patch.path) : undefined;
			if (
				!patch ||
				(patch.status !== 'CONFLICT' && patch.status !== 'INVALID') ||
				!patch.error
			) {
				vscode.window.showInformationMessage('Select a conflicting or invalid patch.');
				return;
			}

			showPatchError(patch.name, patch.status, patch.error);
		}),
		vscode.commands.registerCommand('patch-transfer.refresh', refreshChanges),
		vscode.commands.registerCommand('patch-transfer.refreshPatches', refreshPatches),
		fileWatcher,
		fileWatcher.onDidCreate(scheduleChangesRefresh),
		fileWatcher.onDidChange(scheduleChangesRefresh),
		fileWatcher.onDidDelete(scheduleChangesRefresh),
		patchWatcher,
		patchWatcher.onDidCreate(schedulePatchesRefresh),
		patchWatcher.onDidChange(schedulePatchesRefresh),
		patchWatcher.onDidDelete(schedulePatchesRefresh),
		patchesView.onDidChangeSelection(event => updatePatchCommandContexts(event.selection[0])),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void (async () => {
				await ensureActiveRepositorySetup();
				await Promise.all([refreshChanges(), refreshPatches()]);
				await changesViewProvider.refreshRepository();
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
