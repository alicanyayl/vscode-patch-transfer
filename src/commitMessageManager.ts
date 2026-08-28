export const generateCommitMessageCommand = 'github.copilot.git.generateCommitMessage';

export interface CommitMessageRepository {
	readonly rootUri: unknown;
	inputBox: {
		value: string;
	};
}

export interface CommitMessageCommandBridge {
	getCommands(): Promise<readonly string[]>;
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface CommitMessageWaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	now?: () => number;
	delay?: (milliseconds: number) => Promise<void>;
}

export interface CommitMessageSnapshot {
	repositoryAvailable: boolean;
	message: string;
}

export interface CommitMessageSession extends CommitMessageSnapshot {
	complete(commitSucceeded: boolean): void;
}

export type GenerateCommitMessageResult =
	| { status: 'generated'; message: string }
	| { status: 'unavailable' }
	| { status: 'noRepository' }
	| { status: 'noResult'; message: string };

export class CommitMessageManager {
	private repository: CommitMessageRepository | undefined;

	constructor(
		private readonly resolveRepository: () => Promise<CommitMessageRepository | undefined>,
		private readonly commands: CommitMessageCommandBridge,
		private readonly waitOptions: CommitMessageWaitOptions = {},
	) {}

	async refreshRepository(): Promise<CommitMessageSnapshot> {
		this.repository = await this.resolveRepository();
		return this.getSnapshot();
	}

	getSnapshot(): CommitMessageSnapshot {
		return this.repository
			? { repositoryAvailable: true, message: this.repository.inputBox.value }
			: { repositoryAvailable: false, message: '' };
	}

	async updateCommitMessage(message: string): Promise<boolean> {
		const repository = this.repository ?? await this.resolveRepository();
		if (!repository) {
			this.repository = undefined;
			return false;
		}

		this.repository = repository;
		repository.inputBox.value = message;
		return true;
	}

	async beginCreatePatch(): Promise<CommitMessageSession> {
		const snapshot = await this.refreshRepository();
		const repository = this.repository;

		return {
			...snapshot,
			complete: commitSucceeded => {
				if (commitSucceeded && repository) {
					repository.inputBox.value = '';
				}
			},
		};
	}

	async generateCommitMessage(): Promise<GenerateCommitMessageResult> {
		const snapshot = await this.refreshRepository();
		const repository = this.repository;
		if (!snapshot.repositoryAvailable || !repository) {
			return { status: 'noRepository' };
		}

		const availableCommands = await this.commands.getCommands();
		if (!availableCommands.includes(generateCommitMessageCommand)) {
			return { status: 'unavailable' };
		}

		const startingMessage = repository.inputBox.value;
		await this.commands.executeCommand(generateCommitMessageCommand, repository.rootUri);
		const generatedMessage = await this.waitForCommitMessageChange(repository, startingMessage);
		if (generatedMessage === undefined) {
			repository.inputBox.value = startingMessage;
			return { status: 'noResult', message: startingMessage };
		}

		return { status: 'generated', message: generatedMessage };
	}

	private async waitForCommitMessageChange(
		repository: CommitMessageRepository,
		startingMessage: string,
	): Promise<string | undefined> {
		const timeoutMs = this.waitOptions.timeoutMs ?? 10_000;
		const pollIntervalMs = this.waitOptions.pollIntervalMs ?? 100;
		const now = this.waitOptions.now ?? Date.now;
		const delay = this.waitOptions.delay ?? (milliseconds => new Promise<void>(resolve => {
			setTimeout(resolve, milliseconds);
		}));
		const deadline = now() + timeoutMs;

		while (true) {
			const currentMessage = repository.inputBox.value;
			if (currentMessage !== startingMessage && currentMessage.trim().length > 0) {
				return currentMessage;
			}

			const remainingMs = deadline - now();
			if (remainingMs <= 0) {
				return undefined;
			}
			await delay(Math.min(pollIntervalMs, remainingMs));
		}
	}
}
