import { DiffHunk, normalizeLineEndings } from './patchHunkParser';

export interface HunkMatchResult {
	safe: boolean;
	startLine?: number;
	endLine?: number;
	currentText: string;
	unsafeReason?: string;
}

/**
 * Finds all occurrences of subLines inside lines array.
 * Returns array of starting line indices.
 */
export function findSubarrayIndices(lines: string[], subLines: string[]): number[] {
	if (subLines.length === 0 || lines.length < subLines.length) {
		return [];
	}

	const indices: number[] = [];
	const maxStart = lines.length - subLines.length;

	for (let i = 0; i <= maxStart; i++) {
		let match = true;
		for (let j = 0; j < subLines.length; j++) {
			if (lines[i + j] !== subLines[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			indices.push(i);
		}
	}

	return indices;
}

/**
 * Deterministically locates where a rejected DiffHunk belongs in the target file content.
 * Never guesses. If ambiguous or not found, marks as unsafe for automatic replacement.
 */
export function matchHunkInTarget(targetContent: string, hunk: DiffHunk): HunkMatchResult {
	const normalizedTarget = normalizeLineEndings(targetContent);
	const targetLines = normalizedTarget.length === 0 ? [] : normalizedTarget.split('\n');

	// 1. Try exact match of patchOldText (context + removed lines)
	if (hunk.patchOldText.length > 0) {
		const oldLines = hunk.patchOldText.split('\n');
		const exactMatches = findSubarrayIndices(targetLines, oldLines);

		if (exactMatches.length === 1) {
			const startLine = exactMatches[0];
			const endLine = startLine + oldLines.length;
			const currentText = targetLines.slice(startLine, endLine).join('\n');
			return {
				safe: true,
				startLine,
				endLine,
				currentText,
			};
		}

		if (exactMatches.length > 1) {
			return {
				safe: false,
				currentText: hunk.patchOldText,
				unsafeReason: 'Multiple matching regions found in file; manual resolution required.',
			};
		}
	}

	// 2. Try unique surrounding context (leading and trailing anchors)
	const leading = hunk.leadingContext;
	const trailing = hunk.trailingContext;

	if (leading.length > 0 && trailing.length > 0) {
		const leadMatches = findSubarrayIndices(targetLines, leading);
		const trailMatches = findSubarrayIndices(targetLines, trailing);

		// Find candidate pairs where leading comes before trailing within reasonable span
		const candidatePairs: Array<{ leadIdx: number; trailIdx: number }> = [];
		const maxSpan = Math.max(hunk.oldLines * 3, 50);

		for (const l of leadMatches) {
			const leadEnd = l + leading.length;
			for (const t of trailMatches) {
				if (t >= leadEnd && t - leadEnd <= maxSpan) {
					candidatePairs.push({ leadIdx: l, trailIdx: t });
				}
			}
		}

		if (candidatePairs.length === 1) {
			const { leadIdx, trailIdx } = candidatePairs[0];
			const startLine = leadIdx;
			const endLine = trailIdx + trailing.length;
			const currentText = targetLines.slice(startLine, endLine).join('\n');
			return {
				safe: true,
				startLine,
				endLine,
				currentText,
			};
		}

		if (candidatePairs.length > 1) {
			return {
				safe: false,
				currentText: hunk.patchOldText,
				unsafeReason: 'Multiple possible regions match surrounding context; manual resolution required.',
			};
		}
	}

	// 3. Leading context only at file start
	if (leading.length === 0 && trailing.length > 0 && hunk.oldStart === 1) {
		const trailMatches = findSubarrayIndices(targetLines, trailing);
		if (trailMatches.length === 1 && trailMatches[0] <= Math.max(hunk.oldLines * 2, 20)) {
			const endLine = trailMatches[0] + trailing.length;
			const currentText = targetLines.slice(0, endLine).join('\n');
			return {
				safe: true,
				startLine: 0,
				endLine,
				currentText,
			};
		}
	}

	// 4. Trailing context only at file end
	if (trailing.length === 0 && leading.length > 0) {
		const leadMatches = findSubarrayIndices(targetLines, leading);
		if (leadMatches.length === 1 && targetLines.length - leadMatches[0] <= Math.max(hunk.oldLines * 2, 20)) {
			const startLine = leadMatches[0];
			const endLine = targetLines.length;
			const currentText = targetLines.slice(startLine, endLine).join('\n');
			return {
				safe: true,
				startLine,
				endLine,
				currentText,
			};
		}
	}

	return {
		safe: false,
		currentText: hunk.patchOldText || '(content unavailable)',
		unsafeReason: 'Could not safely locate the conflict region in current file; manual resolution required.',
	};
}

/**
 * Applies the incoming patch replacement to targetContent at the matched region.
 */
export function applyHunkReplacement(
	targetContent: string,
	match: HunkMatchResult,
	hunk: DiffHunk,
): string {
	if (!match.safe || match.startLine === undefined || match.endLine === undefined) {
		throw new Error('Cannot apply patch hunk: match is not safe.');
	}

	const isCrlf = targetContent.includes('\r\n');
	const normalizedTarget = normalizeLineEndings(targetContent);
	const targetLines = normalizedTarget.length === 0 ? [] : normalizedTarget.split('\n');

	const replacementLines = hunk.patchNewText.split('\n');
	const before = targetLines.slice(0, match.startLine);
	const after = targetLines.slice(match.endLine);

	const resultLines = [...before, ...replacementLines, ...after];
	const separator = isCrlf ? '\r\n' : '\n';
	return resultLines.join(separator);
}
