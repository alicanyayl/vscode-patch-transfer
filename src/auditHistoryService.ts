import { randomBytes } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { GitService } from './gitService';

export type AuditEventType = 'CREATED' | 'IMPORTED' | 'APPLIED' | 'UNDONE';

export interface AuditEvent {
	timestamp: string;
	event: AuditEventType;
	patchSha256: string;
	patchFileName: string;
	sourceCommitSha?: string;
	filesCount?: number;
}

export interface AuditHistory {
	version: 1;
	events: AuditEvent[];
}

export interface HistorySummaryState {
	totalPatches?: number;
	currentlyApplied?: number;
}

export class AuditHistoryService {
	constructor(private readonly gitService: GitService) {}

	async getHistoryPath(repositoryPath: string): Promise<string> {
		const gitDirectory = await this.gitService.getGitDirectory(repositoryPath);
		return join(gitDirectory, 'patch-transfer', 'history.json');
	}

	async loadHistory(repositoryPath: string): Promise<AuditHistory> {
		try {
			const historyPath = await this.getHistoryPath(repositoryPath);
			const contents = await readFile(historyPath, 'utf8');
			const parsed = JSON.parse(contents) as Record<string, unknown>;
			if (parsed.version === 1 && Array.isArray(parsed.events)) {
				return {
					version: 1,
					events: (parsed.events as unknown[]).filter(this.isValidAuditEvent),
				};
			}
		} catch {
			// File does not exist or corrupted; return default empty history.
		}

		return {
			version: 1,
			events: [],
		};
	}

	async recordEvent(repositoryPath: string, event: AuditEvent): Promise<void> {
		try {
			const history = await this.loadHistory(repositoryPath);
			history.events.push(event);
			const historyPath = await this.getHistoryPath(repositoryPath);
			await this.atomicWriteJson(historyPath, history);
		} catch {
			// Best-effort write. Audit failure must not crash core operations.
		}
	}

	formatHistoryDocument(
		history: AuditHistory,
		repositoryName?: string,
		currentState?: HistorySummaryState,
	): string {
		const total = history.events.length;
		const applied = history.events.filter(e => e.event === 'APPLIED').length;
		const undone = history.events.filter(e => e.event === 'UNDONE').length;
		const created = history.events.filter(e => e.event === 'CREATED').length;
		const imported = history.events.filter(e => e.event === 'IMPORTED').length;

		const lines: string[] = [
			'PATCH TRANSFER HISTORY',
			'',
			repositoryName ? `Repository: ${repositoryName}` : 'Repository',
			'----------',
		];

		if (currentState?.totalPatches !== undefined) {
			lines.push(`Total patches: ${currentState.totalPatches}`);
		}
		if (currentState?.currentlyApplied !== undefined) {
			lines.push(`Currently applied: ${currentState.currentlyApplied}`);
		}

		lines.push(
			`Total audit events: ${total}`,
			`Applied events: ${applied}`,
			`Undone events: ${undone}`,
			`Created events: ${created}`,
			`Imported events: ${imported}`,
			'',
			'TIMELINE',
		);

		if (history.events.length === 0) {
			lines.push('', 'No audit events recorded yet.');
		} else {
			// Reverse chronological (newest first).
			const reversed = [...history.events].reverse();
			for (const event of reversed) {
				lines.push('');
				lines.push(this.formatTimestamp(event.timestamp));
				lines.push(event.event);
				lines.push(event.patchFileName);
				lines.push(`SHA: ${event.patchSha256}`);
				if (event.sourceCommitSha) {
					lines.push(`Commit: ${event.sourceCommitSha}`);
				}
				if (event.filesCount !== undefined) {
					lines.push(`Files: ${event.filesCount}`);
				}
			}
		}

		return `${lines.join('\n')}\n`;
	}

	private formatTimestamp(isoString: string): string {
		try {
			const d = new Date(isoString);
			if (!Number.isNaN(d.getTime())) {
				return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
			}
		} catch {
			// Fallback.
		}
		return isoString;
	}

	private isValidAuditEvent(value: unknown): value is AuditEvent {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const data = value as Record<string, unknown>;
		const validEvents = new Set(['CREATED', 'IMPORTED', 'APPLIED', 'UNDONE']);
		return (
			typeof data.timestamp === 'string' &&
			typeof data.event === 'string' &&
			validEvents.has(data.event) &&
			typeof data.patchSha256 === 'string' &&
			typeof data.patchFileName === 'string'
		);
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
