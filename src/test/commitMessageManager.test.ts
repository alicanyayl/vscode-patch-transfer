import * as assert from 'assert';
import {
	CommitMessageManager,
	generateCommitMessageCommand,
} from '../commitMessageManager';

suite('Commit message manager', () => {
	test('keeps manual editing functional when AI generation is unavailable', async () => {
		const repository = { rootUri: 'repository-root', inputBox: { value: '' } };
		let commandInvoked = false;
		const manager = new CommitMessageManager(
			async () => repository,
			{
				getCommands: async () => ['unrelated.command'],
				executeCommand: async () => {
					commandInvoked = true;
				},
			},
		);

		await manager.refreshRepository();
		assert.strictEqual(await manager.updateCommitMessage('fix: manual fallback'), true);
		assert.deepStrictEqual(await manager.generateCommitMessage(), { status: 'unavailable' });
		assert.strictEqual(commandInvoked, false);
		assert.strictEqual(repository.inputBox.value, 'fix: manual fallback');
		assert.strictEqual(manager.getSnapshot().message, 'fix: manual fallback');
	});

	test('passes repository context and waits for an asynchronous generated value', async () => {
		const rootUri = { scheme: 'file', path: '/repository' };
		const repository = { rootUri, inputBox: { value: '' } };
		let currentTime = 0;
		let commandResolved = false;
		let waitCount = 0;
		const manager = new CommitMessageManager(
			async () => repository,
			{
				getCommands: async () => [generateCommitMessageCommand],
				executeCommand: async (command, argument) => {
					assert.strictEqual(command, generateCommitMessageCommand);
					assert.strictEqual(argument, rootUri);
					commandResolved = true;
				},
			},
			{
				timeoutMs: 50,
				pollIntervalMs: 10,
				now: () => currentTime,
				delay: async milliseconds => {
					assert.strictEqual(commandResolved, true);
					currentTime += milliseconds;
					waitCount++;
					if (waitCount === 2) {
						repository.inputBox.value = 'feat: generated message';
					}
				},
			},
		);

		assert.deepStrictEqual(
			await manager.generateCommitMessage(),
			{ status: 'generated', message: 'feat: generated message' },
		);
		assert.strictEqual(waitCount, 2);
		assert.strictEqual(manager.getSnapshot().message, 'feat: generated message');

		assert.strictEqual(await manager.updateCommitMessage('feat: edited generated message'), true);
		assert.strictEqual(repository.inputBox.value, 'feat: edited generated message');
	});

	test('preserves the previous manual value when generation times out', async () => {
		const repository = {
			rootUri: 'repository-root',
			inputBox: { value: 'fix: keep manual message' },
		};
		let currentTime = 0;
		const manager = new CommitMessageManager(
			async () => repository,
			{
				getCommands: async () => [generateCommitMessageCommand],
				executeCommand: async () => {
					repository.inputBox.value = '';
				},
			},
			{
				timeoutMs: 30,
				pollIntervalMs: 10,
				now: () => currentTime,
				delay: async milliseconds => {
					currentTime += milliseconds;
				},
			},
		);

		assert.deepStrictEqual(
			await manager.generateCommitMessage(),
			{ status: 'noResult', message: 'fix: keep manual message' },
		);
		assert.strictEqual(repository.inputBox.value, 'fix: keep manual message');
		assert.strictEqual(manager.getSnapshot().message, 'fix: keep manual message');
	});

	test('clears only when a create session reports that commit succeeded', async () => {
		const repository = {
			rootUri: 'repository-root',
			inputBox: { value: 'fix: keep after failure' },
		};
		const manager = new CommitMessageManager(
			async () => repository,
			{
				getCommands: async () => [],
				executeCommand: async () => undefined,
			},
		);

		const failedSession = await manager.beginCreatePatch();
		failedSession.complete(false);
		assert.strictEqual(repository.inputBox.value, 'fix: keep after failure');

		repository.inputBox.value = 'feat: consume after commit';
		const successfulSession = await manager.beginCreatePatch();
		successfulSession.complete(true);
		assert.strictEqual(repository.inputBox.value, '');
		assert.strictEqual(manager.getSnapshot().message, '');
	});
});
