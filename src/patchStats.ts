import { basename } from 'path';

export type PatchPreviewChangeType = 'Modified' | 'Added' | 'Deleted' | 'Renamed';

export interface PatchPreviewFile {
	path: string;
	originalPath?: string;
	changeType: PatchPreviewChangeType;
	additions?: number;
	deletions?: number;
}

export interface PatchSummaryEntry {
	path: string;
	originalPath?: string;
	changeType: Exclude<PatchPreviewChangeType, 'Modified'>;
}

export interface PatchPreview {
	patchName: string;
	files: PatchPreviewFile[];
}

export function parsePatchNumStat(output: string): PatchPreviewFile[] {
	return output
		.split(/\r?\n/)
		.filter(line => line.length > 0)
		.map(line => {
			const [added, deleted, ...pathParts] = line.split('\t');
			if (!added || !deleted || pathParts.length === 0) {
				throw new Error(`Could not parse patch statistics: ${line}`);
			}

			return {
				path: pathParts.join('\t'),
				changeType: 'Modified' as const,
				additions: parsePatchLineCount(added),
				deletions: parsePatchLineCount(deleted),
			};
		});
}

export function parsePatchSummary(output: string): PatchSummaryEntry[] {
	const entries: PatchSummaryEntry[] = [];
	let renameFrom: string | undefined;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		let match = /^create mode \d+ (.+)$/.exec(line);
		if (match) {
			entries.push({ path: match[1], changeType: 'Added' });
			continue;
		}

		match = /^delete mode \d+ (.+)$/.exec(line);
		if (match) {
			entries.push({ path: match[1], changeType: 'Deleted' });
			continue;
		}

		match = /^rename (.+) => (.+) \(\d+%\)$/.exec(line);
		if (match) {
			entries.push({
				path: match[2],
				originalPath: match[1],
				changeType: 'Renamed',
			});
			continue;
		}

		match = /^rename from (.+)$/.exec(line);
		if (match) {
			renameFrom = match[1];
			continue;
		}

		match = /^rename to (.+)$/.exec(line);
		if (match && renameFrom) {
			entries.push({
				path: match[1],
				originalPath: renameFrom,
				changeType: 'Renamed',
			});
			renameFrom = undefined;
		}
	}

	return entries;
}

export function applyPatchSummary(
	files: PatchPreviewFile[],
	summaryEntries: PatchSummaryEntry[],
): void {
	for (const summary of summaryEntries) {
		const file = files.find(candidate =>
			candidate.path === summary.path ||
			(summary.changeType === 'Renamed' &&
				candidate.changeType === 'Modified' &&
				(candidate.path.includes('=>') ||
					candidate.path.includes(summary.path) ||
					candidate.path.includes(summary.originalPath ?? '\0'))),
		);
		if (file) {
			file.path = summary.path;
			file.originalPath = summary.originalPath;
			file.changeType = summary.changeType;
		} else {
			files.push({ ...summary });
		}
	}
}

export function buildPatchPreview(
	patchPath: string,
	numStatOutput: string,
	summaryOutput: string,
): PatchPreview {
	const files = parsePatchNumStat(numStatOutput);
	applyPatchSummary(files, parsePatchSummary(summaryOutput));
	return { patchName: basename(patchPath), files };
}

export function extractAffectedPathsFromOutputs(
	numStatOutput: string,
	summaryOutput: string,
): string[] {
	const files = parsePatchNumStat(numStatOutput);
	applyPatchSummary(files, parsePatchSummary(summaryOutput));

	const paths = new Set<string>();
	for (const file of files) {
		paths.add(file.path);
		if (file.originalPath) {
			paths.add(file.originalPath);
		}
	}

	return [...paths];
}

function parsePatchLineCount(value: string): number | undefined {
	return /^\d+$/.test(value) ? Number(value) : undefined;
}
