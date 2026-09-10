import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'path';

export interface RepositoryChoice {
	path: string;
	name: string;
}

export type RepositoryPicker = (
	repositories: readonly RepositoryChoice[],
) => Promise<string | undefined>;

export interface RepositoryContextOptions {
	promptIfAmbiguous?: boolean;
	picker?: RepositoryPicker;
}

/**
 * Owns the single repository used by every Patch Transfer view and command.
 * Repository discovery is injected so selection rules can be tested without UI.
 */
export class PatchTransferRepositoryContext {
	private repositoryChoices: RepositoryChoice[] = [];
	private selectedPath: string | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly discoverRepositoryPaths: () => Promise<readonly string[]>,
		private readonly getActiveEditorPath: () => string | undefined,
	) {}

	get repositoryPath(): string | undefined {
		return this.selectedPath;
	}

	get repositories(): readonly RepositoryChoice[] {
		return this.repositoryChoices;
	}

	get repositoryCount(): number {
		return this.repositoryChoices.length;
	}

	get displayName(): string | undefined {
		return this.selectedPath ? basename(this.selectedPath) : undefined;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async refresh(options: RepositoryContextOptions = {}): Promise<string | undefined> {
		const paths = await this.discoverRepositoryPaths();
		const choices = this.createChoices(paths);
		const choicesChanged = this.repositoryListsDiffer(this.repositoryChoices, choices);
		this.repositoryChoices = choices;

		const retainedSelection = this.selectedPath
			? choices.find(choice => this.pathsEqual(choice.path, this.selectedPath as string))
			: undefined;
		if (retainedSelection) {
			this.updateSelection(retainedSelection.path, choicesChanged);
			return this.selectedPath;
		}

		const previousSelection = this.selectedPath;
		this.selectedPath = undefined;

		if (choices.length === 1) {
			this.updateSelection(choices[0].path, choicesChanged || previousSelection !== undefined);
			return this.selectedPath;
		}

		const activeEditorRepository = this.findRepositoryContaining(
			this.getActiveEditorPath(),
			choices,
		);
		if (activeEditorRepository) {
			this.updateSelection(
				activeEditorRepository.path,
				choicesChanged || previousSelection !== undefined,
			);
			return this.selectedPath;
		}

		if (options.promptIfAmbiguous && options.picker && choices.length > 1) {
			const pickedPath = await options.picker(choices);
			const picked = pickedPath
				? choices.find(choice => this.pathsEqual(choice.path, pickedPath))
				: undefined;
			if (picked) {
				this.updateSelection(picked.path, true);
				return this.selectedPath;
			}
		}

		if (choicesChanged || previousSelection !== undefined) {
			this.fireDidChange();
		}
		return undefined;
	}

	async select(picker: RepositoryPicker): Promise<string | undefined> {
		const paths = await this.discoverRepositoryPaths();
		const choices = this.createChoices(paths);
		const choicesChanged = this.repositoryListsDiffer(this.repositoryChoices, choices);
		this.repositoryChoices = choices;

		if (choices.length === 0) {
			const hadSelection = this.selectedPath !== undefined;
			this.selectedPath = undefined;
			if (choicesChanged || hadSelection) {
				this.fireDidChange();
			}
			return undefined;
		}

		if (choices.length === 1) {
			this.updateSelection(choices[0].path, choicesChanged);
			return this.selectedPath;
		}

		const pickedPath = await picker(choices);
		const picked = pickedPath
			? choices.find(choice => this.pathsEqual(choice.path, pickedPath))
			: undefined;
		if (!picked) {
			if (choicesChanged) {
				this.fireDidChange();
			}
			return this.selectedPath;
		}

		this.updateSelection(picked.path, choicesChanged || !this.pathsEqualOptional(this.selectedPath, picked.path));
		return this.selectedPath;
	}

	isActiveLocalPatchFile(filePath: string): boolean {
		if (!this.selectedPath || extname(filePath).toLowerCase() !== '.patch') {
			return false;
		}

		return this.pathsEqual(
			dirname(resolve(filePath)),
			resolve(this.selectedPath, '.patch-transfer'),
		);
	}

	getLocalPatchDirectory(): string | undefined {
		return this.selectedPath
			? resolve(this.selectedPath, '.patch-transfer')
			: undefined;
	}

	private createChoices(paths: readonly string[]): RepositoryChoice[] {
		const unique = new Map<string, string>();
		for (const path of paths) {
			const resolvedPath = resolve(path);
			unique.set(this.normalizePath(resolvedPath), resolvedPath);
		}

		return [...unique.values()]
			.map(path => ({ path, name: basename(path) || path }))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	private findRepositoryContaining(
		filePath: string | undefined,
		choices: readonly RepositoryChoice[],
	): RepositoryChoice | undefined {
		if (!filePath) {
			return undefined;
		}

		return choices
			.filter(choice => this.isWithin(choice.path, filePath))
			.sort((left, right) => right.path.length - left.path.length)[0];
	}

	private isWithin(repositoryPath: string, filePath: string): boolean {
		const relativePath = relative(resolve(repositoryPath), resolve(filePath));
		return relativePath === '' || (
			!relativePath.startsWith(`..${sep}`) &&
			relativePath !== '..' &&
			!isAbsolute(relativePath)
		);
	}

	private updateSelection(path: string, forceEvent: boolean): void {
		const changed = !this.pathsEqualOptional(this.selectedPath, path);
		this.selectedPath = path;
		if (changed || forceEvent) {
			this.fireDidChange();
		}
	}

	private fireDidChange(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private repositoryListsDiffer(
		left: readonly RepositoryChoice[],
		right: readonly RepositoryChoice[],
	): boolean {
		return left.length !== right.length || left.some((choice, index) =>
			!this.pathsEqual(choice.path, right[index].path),
		);
	}

	private pathsEqualOptional(left: string | undefined, right: string | undefined): boolean {
		if (!left || !right) {
			return left === right;
		}
		return this.pathsEqual(left, right);
	}

	private pathsEqual(left: string, right: string): boolean {
		return this.normalizePath(left) === this.normalizePath(right);
	}

	private normalizePath(path: string): string {
		const normalized = resolve(path);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}
}
