import { randomBytes } from 'crypto';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { GitService } from './gitService';
import { PatchState } from './patchStateService';

export interface PatchMetadata {
	version: 1;
	patchSha256: string;
	patchFileName: string;
	createdAt: string;
	source: {
		commitSha?: string;
		branch?: string;
		repositoryName?: string;
	};
	chain: {
		previousPatchSha256: string | null;
	};
	stats?: {
		files: number;
		additions?: number;
		deletions?: number;
	};
	paths: string[];
	extensionVersion: string;
}

export function getPatchMetadataFileName(patchFileName: string): string {
	return patchFileName.endsWith('.patch')
		? `${patchFileName.slice(0, -6)}.patchmeta.json`
		: `${patchFileName}.patchmeta.json`;
}

export class PatchMetadataService {
	constructor(private readonly gitService: GitService) {}

	async writeSidecar(patchPath: string, metadata: PatchMetadata): Promise<void> {
		const directory = dirname(patchPath);
		const sidecarFileName = getPatchMetadataFileName(metadata.patchFileName);
		const targetPath = join(directory, sidecarFileName);
		await this.atomicWriteJson(targetPath, metadata);
	}

	async readSidecar(patchPath: string): Promise<PatchMetadata | undefined> {
		const directory = dirname(patchPath);
		const patchFileName = patchPath.split(/[\\/]/).pop() ?? '';
		const sidecarFileName = getPatchMetadataFileName(patchFileName);
		const targetPath = join(directory, sidecarFileName);

		try {
			const contents = await readFile(targetPath, 'utf8');
			const parsed = JSON.parse(contents);
			return this.validateMetadata(parsed);
		} catch {
			return undefined;
		}
	}

	async saveLocalMetadata(
		repositoryPath: string,
		patchSha: string,
		metadata: PatchMetadata,
	): Promise<void> {
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		const metadataDirectory = join(gitDirectory, 'patch-transfer', 'metadata');
		await mkdir(metadataDirectory, { recursive: true });
		const targetPath = join(metadataDirectory, `${patchSha}.json`);
		await this.atomicWriteJson(targetPath, metadata);
	}

	async getLocalMetadata(
		repositoryPath: string,
		patchSha: string,
	): Promise<PatchMetadata | undefined> {
		try {
			const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
			const targetPath = join(gitDirectory, 'patch-transfer', 'metadata', `${patchSha}.json`);
			const contents = await readFile(targetPath, 'utf8');
			const parsed = JSON.parse(contents);
			return this.validateMetadata(parsed);
		} catch {
			return undefined;
		}
	}

	async getEffectiveMetadata(
		repositoryPath: string,
		patchPath: string,
		patchSha?: string,
	): Promise<PatchMetadata | undefined> {
		const sidecar = await this.readSidecar(patchPath);
		if (sidecar && (!patchSha || sidecar.patchSha256 === patchSha)) {
			return sidecar;
		}

		if (patchSha) {
			const local = await this.getLocalMetadata(repositoryPath, patchSha);
			if (local) {
				return local;
			}
		}

		return undefined;
	}

	validateMetadata(
		candidate: unknown,
		expectedPatchSha?: string,
		expectedPatchFileName?: string,
	): PatchMetadata | undefined {
		if (!candidate || typeof candidate !== 'object') {
			return undefined;
		}

		const data = candidate as Record<string, unknown>;
		if (data.version !== 1) {
			return undefined;
		}

		if (typeof data.patchSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(data.patchSha256)) {
			return undefined;
		}

		if (typeof data.patchFileName !== 'string' || !data.patchFileName.trim()) {
			return undefined;
		}

		if (expectedPatchSha && data.patchSha256.toLowerCase() !== expectedPatchSha.toLowerCase()) {
			return undefined;
		}

		if (expectedPatchFileName && data.patchFileName !== expectedPatchFileName) {
			return undefined;
		}

		if (typeof data.createdAt !== 'string' || Number.isNaN(Date.parse(data.createdAt))) {
			return undefined;
		}

		if (!data.chain || typeof data.chain !== 'object') {
			return undefined;
		}

		const chain = data.chain as Record<string, unknown>;
		if (chain.previousPatchSha256 !== null && typeof chain.previousPatchSha256 !== 'string') {
			return undefined;
		}

		const source = (data.source && typeof data.source === 'object')
			? data.source as Record<string, unknown>
			: {};

		const stats = (data.stats && typeof data.stats === 'object')
			? data.stats as Record<string, unknown>
			: undefined;

		const paths = Array.isArray(data.paths)
			? (data.paths as unknown[]).filter((p): p is string => typeof p === 'string')
			: [];

		return {
			version: 1,
			patchSha256: data.patchSha256,
			patchFileName: data.patchFileName,
			createdAt: data.createdAt,
			source: {
				commitSha: typeof source.commitSha === 'string' ? source.commitSha : undefined,
				branch: typeof source.branch === 'string' ? source.branch : undefined,
				repositoryName: typeof source.repositoryName === 'string' ? source.repositoryName : undefined,
			},
			chain: {
				previousPatchSha256: typeof chain.previousPatchSha256 === 'string'
					? chain.previousPatchSha256
					: null,
			},
			stats: stats ? {
				files: typeof stats.files === 'number' ? stats.files : 0,
				additions: typeof stats.additions === 'number' ? stats.additions : undefined,
				deletions: typeof stats.deletions === 'number' ? stats.deletions : undefined,
			} : undefined,
			paths,
			extensionVersion: typeof data.extensionVersion === 'string' ? data.extensionVersion : '0.1.0',
		};
	}

	async checkChainGap(
		repositoryPath: string,
		metadata: PatchMetadata,
		state: PatchState,
		knownLocalPatchShas: Set<string>,
	): Promise<{ hasGap: boolean; missingSha?: string }> {
		const previousSha = metadata.chain.previousPatchSha256;
		if (!previousSha) {
			return { hasGap: false };
		}

		// Check if known in applied state.
		if (state.applied[previousSha]) {
			return { hasGap: false };
		}

		// Check if known in created state.
		if (state.created[previousSha]) {
			return { hasGap: false };
		}

		// Check if known in current local patch candidate SHAs.
		if (knownLocalPatchShas.has(previousSha)) {
			return { hasGap: false };
		}

		// Check if stored in local metadata store.
		const localMeta = await this.getLocalMetadata(repositoryPath, previousSha);
		if (localMeta) {
			return { hasGap: false };
		}

		return { hasGap: true, missingSha: previousSha };
	}

	private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
		const directory = dirname(filePath);
		await mkdir(directory, { recursive: true });
		const tempPath = join(
			directory,
			`.tmp-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.json`,
		);

		await writeFile(tempPath, `${JSON.stringify(data, undefined, 2)}\n`, 'utf8');
		await rename(tempPath, filePath);
	}
}
