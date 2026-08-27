import { relative } from 'path';
import * as vscode from 'vscode';
import { ChangesTreeProvider } from './changesTreeProvider';
import { GitService } from './gitService';
import { PatchService } from './patchService';
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
	const changesProvider = new ChangesTreeProvider(gitService);
	const patchService = new PatchService(gitService);
	const patchesProvider = new PatchesTreeProvider(gitService, patchService);

	await Promise.all([changesProvider.refresh(), patchesProvider.refresh()]);

	const changesView = vscode.window.createTreeView('patch-transfer.changes', {
		treeDataProvider: changesProvider,
	});
	const patchesView = vscode.window.createTreeView('patch-transfer.patches', {
		treeDataProvider: patchesProvider,
	});
	const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
	const patchWatcher = vscode.workspace.createFileSystemWatcher('**/.patch-transfer/*.patch');
	const outputChannel = vscode.window.createOutputChannel('Patch Transfer');
	let activeOperation: 'creating' | 'applying' | undefined;
	let changesRefreshTimer: NodeJS.Timeout | undefined;
	let patchesRefreshTimer: NodeJS.Timeout | undefined;
	let lastPatchRefreshError: string | undefined;

	const updateBadges = () => {
		changesView.badge = changesProvider.count > 0
			? {
				value: changesProvider.count,
				tooltip: `${changesProvider.count} working tree change${changesProvider.count === 1 ? '' : 's'}`,
			}
			: undefined;
		patchesView.badge = patchesProvider.count > 0
			? {
				value: patchesProvider.count,
				tooltip: `${patchesProvider.count} patch file${patchesProvider.count === 1 ? '' : 's'}`,
			}
			: undefined;
	};

	const refreshChanges = async () => {
		await changesProvider.refresh();
		updateBadges();
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

	updateBadges();
	updatePatchCommandContexts();
	reportPatchRefreshError();

	context.subscriptions.push(
		changesView,
		patchesView,
		outputChannel,
		vscode.window.registerFileDecorationProvider(changesProvider),
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

			activeOperation = 'creating';
			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Creating patch...',
						cancellable: false,
					},
					() => patchService.createPatch(workspacePath),
				);

				if (result.status === 'noChanges') {
					vscode.window.showInformationMessage('No changes available to create a patch.');
				} else if (result.status === 'pushFailed') {
					vscode.window.showErrorMessage(
						`Patch created: ${result.patchName}\nCommit succeeded, but push failed: ${result.error}`,
					);
				} else {
					vscode.window.showInformationMessage(
						`Patch created: ${result.patchName}\nCommit and push completed.`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(message);
			} finally {
				await Promise.all([refreshChanges(), refreshPatches()]);
				activeOperation = undefined;
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

			activeOperation = 'applying';
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
				activeOperation = undefined;
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
			void Promise.all([refreshChanges(), refreshPatches()]);
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
