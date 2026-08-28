import { resolve } from 'path';
import * as vscode from 'vscode';
import { CommitMessageRepository } from './commitMessageManager';

export interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): GitAPI;
}

interface GitAPI {
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
	readonly onDidCloseRepository: vscode.Event<GitRepository>;
	getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitRepository extends CommitMessageRepository {
	readonly rootUri: vscode.Uri;
}

export class VsCodeGitRepositoryResolver {
	private apiPromise: Promise<GitAPI | undefined> | undefined;

	async resolve(repositoryPath: string): Promise<GitRepository | undefined> {
		const api = await this.getAPI();
		if (!api) {
			return undefined;
		}

		const repositoryUri = vscode.Uri.file(repositoryPath);
		return api.getRepository(repositoryUri)
			?? api.repositories.find(repository => this.pathsEqual(repository.rootUri.fsPath, repositoryPath));
	}

	async registerRepositoryListeners(listener: () => void): Promise<vscode.Disposable[]> {
		const api = await this.getAPI();
		return api
			? [api.onDidOpenRepository(listener), api.onDidCloseRepository(listener)]
			: [];
	}

	private async getAPI(): Promise<GitAPI | undefined> {
		this.apiPromise ??= this.loadAPI();
		return this.apiPromise;
	}

	private async loadAPI(): Promise<GitAPI | undefined> {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!gitExtension) {
			return undefined;
		}

		const extension = gitExtension.isActive
			? gitExtension.exports
			: await gitExtension.activate();
		return extension.enabled ? extension.getAPI(1) : undefined;
	}

	private pathsEqual(left: string, right: string): boolean {
		return process.platform === 'win32'
			? resolve(left).toLowerCase() === resolve(right).toLowerCase()
			: resolve(left) === resolve(right);
	}
}
