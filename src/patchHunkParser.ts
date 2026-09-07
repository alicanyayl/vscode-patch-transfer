export type HunkLineType = 'context' | 'add' | 'delete';

export interface DiffHunkLine {
	type: HunkLineType;
	content: string;
}

export interface DiffHunk {
	index: number;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	heading?: string;
	lines: DiffHunkLine[];
	patchOldText: string;
	patchNewText: string;
	deletedLines: string[];
	addedLines: string[];
	leadingContext: string[];
	trailingContext: string[];
}

export interface ParsedPatchFile {
	oldPath: string;
	newPath: string;
	displayPath: string;
	isNewFile: boolean;
	isDeletedFile: boolean;
	isRename: boolean;
	isBinary: boolean;
	binaryBaseUnavailable?: boolean;
	hunks: DiffHunk[];
}

/**
 * Unquotes a Git diff path if it is enclosed in double quotes.
 */
export function unquoteGitPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		const inner = trimmed.slice(1, -1);
		// Process backslash-backslash first to avoid double-unescaping
		return inner
			.replace(/\\\\/g, '\\') 
			.replace(/\\"/g, '"')
			.replace(/\\t/g, '\t')
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r');
	}
	return trimmed;
}

/**
 * Strips the Git "a/" or "b/" prefix from a diff path, unless the path is /dev/null.
 */
export function stripGitPrefix(filePath: string): string {
	const clean = unquoteGitPath(filePath);
	if (clean === '/dev/null') {
		return clean;
	}
	if (clean.startsWith('a/') || clean.startsWith('b/')) {
		return clean.slice(2);
	}
	return clean;
}

/**
 * Normalizes line endings to LF (\n) for consistent parsing.
 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Parses a unified diff hunk header line: @@ -oldStart[,oldCount] +newStart[,newCount] @@ [heading]
 */
export function parseHunkHeader(line: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	heading?: string;
} | undefined {
	const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?: (.*))?$/.exec(line.trim());
	if (!match) {
		return undefined;
	}

	const oldStart = Number(match[1]);
	const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
	const newStart = Number(match[3]);
	const newLines = match[4] !== undefined ? Number(match[4]) : 1;
	const heading = match[5]?.trim();

	return { oldStart, oldLines, newStart, newLines, heading };
}

/**
 * Pure parser for unified diff text (supports full Git patches or .rej files).
 */
export function parsePatchText(diffText: string): ParsedPatchFile[] {
	const normalized = normalizeLineEndings(diffText);
	const lines = normalized.split('\n');
	const files: ParsedPatchFile[] = [];

	let currentFile: ParsedPatchFile | undefined;
	let currentHunk: DiffHunk | undefined;
	let hunkIndex = 0;
	let inBinarySection = false;

	const finalizeHunk = () => {
		if (!currentHunk || !currentFile) {
			return;
		}

		const oldTextLines: string[] = [];
		const newTextLines: string[] = [];
		const deletedLines: string[] = [];
		const addedLines: string[] = [];

		for (const line of currentHunk.lines) {
			if (line.type === 'context') {
				oldTextLines.push(line.content);
				newTextLines.push(line.content);
			} else if (line.type === 'delete') {
				oldTextLines.push(line.content);
				deletedLines.push(line.content);
			} else if (line.type === 'add') {
				newTextLines.push(line.content);
				addedLines.push(line.content);
			}
		}

		// Calculate leading and trailing context
		const leadingContext: string[] = [];
		for (const line of currentHunk.lines) {
			if (line.type === 'context') {
				leadingContext.push(line.content);
			} else {
				break;
			}
		}

		const trailingContext: string[] = [];
		for (let i = currentHunk.lines.length - 1; i >= 0; i--) {
			const line = currentHunk.lines[i];
			if (line.type === 'context') {
				trailingContext.unshift(line.content);
			} else {
				break;
			}
		}

		currentHunk.patchOldText = oldTextLines.join('\n');
		currentHunk.patchNewText = newTextLines.join('\n');
		currentHunk.deletedLines = deletedLines;
		currentHunk.addedLines = addedLines;
		currentHunk.leadingContext = leadingContext;
		currentHunk.trailingContext = trailingContext;

		currentFile.hunks.push(currentHunk);
		currentHunk = undefined;
	};

	const finalizeFile = () => {
		finalizeHunk();
		if (currentFile) {
			files.push(currentFile);
			currentFile = undefined;
			inBinarySection = false;
			hunkIndex = 0;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Check for diff --git header
		if (line.startsWith('diff --git ')) {
			finalizeFile();
			const headerParts = parseDiffGitHeader(line);
			currentFile = {
				oldPath: headerParts.oldPath,
				newPath: headerParts.newPath,
				displayPath: headerParts.newPath !== '/dev/null' ? headerParts.newPath : headerParts.oldPath,
				isNewFile: false,
				isDeletedFile: false,
				isRename: false,
				isBinary: false,
				hunks: [],
			};
			continue;
		}

		// Check for .rej header format: "diff a/file b/file\t(rejected hunks)"
		if (line.startsWith('diff a/') || line.startsWith('diff "a/')) {
			finalizeFile();
			const parts = line.split('\t')[0];
			const headerParts = parseDiffGitHeader(parts);
			currentFile = {
				oldPath: headerParts.oldPath,
				newPath: headerParts.newPath,
				displayPath: headerParts.newPath !== '/dev/null' ? headerParts.newPath : headerParts.oldPath,
				isNewFile: false,
				isDeletedFile: false,
				isRename: false,
				isBinary: false,
				hunks: [],
			};
			continue;
		}

		// Check for .rej header format starting with --- without preceding diff header
		if (!currentFile && line.startsWith('--- ')) {
			finalizeFile();
			const rawPath = line.slice(4).trim();
			const cleanPath = stripGitPrefix(rawPath);
			currentFile = {
				oldPath: cleanPath,
				newPath: cleanPath,
				displayPath: cleanPath !== '/dev/null' ? cleanPath : 'unknown',
				isNewFile: cleanPath === '/dev/null',
				isDeletedFile: false,
				isRename: false,
				isBinary: false,
				hunks: [],
			};
			continue;
		}

		// Fallback for headerless .rej files or isolated hunk outputs
		if (!currentFile && line.startsWith('@@ ')) {
			currentFile = {
				oldPath: 'unknown',
				newPath: 'unknown',
				displayPath: 'unknown',
				isNewFile: false,
				isDeletedFile: false,
				isRename: false,
				isBinary: false,
				hunks: [],
			};
		}

		if (!currentFile) {
			continue;
		}

		// Check for new file mode
		if (line.startsWith('new file mode ')) {
			currentFile.isNewFile = true;
			continue;
		}

		// Check for deleted file mode
		if (line.startsWith('deleted file mode ')) {
			currentFile.isDeletedFile = true;
			continue;
		}

		// Check for rename from / to
		if (line.startsWith('rename from ')) {
			currentFile.isRename = true;
			currentFile.oldPath = stripGitPrefix(line.slice('rename from '.length));
			continue;
		}
		if (line.startsWith('rename to ')) {
			currentFile.isRename = true;
			currentFile.newPath = stripGitPrefix(line.slice('rename to '.length));
			currentFile.displayPath = currentFile.newPath;
			continue;
		}

		// Binary detection
		if (line.startsWith('GIT binary patch') || /^Binary files .* differ$/.test(line)) {
			currentFile.isBinary = true;
			inBinarySection = true;
			continue;
		}

		if (inBinarySection) {
			// Skip binary payload lines
			continue;
		}

		// --- a/path or --- /dev/null
		if (line.startsWith('--- ')) {
			const rawPath = line.slice(4).trim();
			currentFile.oldPath = stripGitPrefix(rawPath);
			if (currentFile.oldPath === '/dev/null') {
				currentFile.isNewFile = true;
			}
			continue;
		}

		// +++ b/path or +++ /dev/null
		if (line.startsWith('+++ ')) {
			const rawPath = line.slice(4).trim();
			currentFile.newPath = stripGitPrefix(rawPath);
			if (currentFile.newPath === '/dev/null') {
				currentFile.isDeletedFile = true;
				currentFile.displayPath = currentFile.oldPath;
			} else {
				currentFile.displayPath = currentFile.newPath;
			}
			continue;
		}

		// Hunk header: @@ ... @@
		if (line.startsWith('@@ ')) {
			finalizeHunk();
			const header = parseHunkHeader(line);
			if (header) {
				currentHunk = {
					index: hunkIndex++,
					header: line,
					oldStart: header.oldStart,
					oldLines: header.oldLines,
					newStart: header.newStart,
					newLines: header.newLines,
					heading: header.heading,
					lines: [],
					patchOldText: '',
					patchNewText: '',
					deletedLines: [],
					addedLines: [],
					leadingContext: [],
					trailingContext: [],
				};
			}
			continue;
		}

		// Hunk lines
		if (currentHunk) {
			if (line.startsWith('+')) {
				currentHunk.lines.push({ type: 'add', content: line.slice(1) });
			} else if (line.startsWith('-')) {
				currentHunk.lines.push({ type: 'delete', content: line.slice(1) });
			} else if (line.startsWith(' ')) {
				currentHunk.lines.push({ type: 'context', content: line.slice(1) });
			} else if (line.startsWith('\\')) {
				// E.g. "\ No newline at end of file"
				// No change to content
			} else if (line === '') {
				// In some unified diff formats or trailing empty lines in hunks:
				// An empty line could be an empty context line if we haven't read
				// all expected lines yet. Track old/new side counts separately
				// since context lines count toward both sides.
				let oldCount = 0;
				let newCount = 0;
				for (const l of currentHunk.lines) {
					if (l.type === 'context') {
						oldCount++;
						newCount++;
					} else if (l.type === 'delete') {
						oldCount++;
					} else if (l.type === 'add') {
						newCount++;
					}
				}
				if (oldCount < currentHunk.oldLines || newCount < currentHunk.newLines) {
					currentHunk.lines.push({ type: 'context', content: '' });
				}
			}
		}
	}

	finalizeFile();
	return files;
}

/**
 * Parses `diff --git a/... b/...` or `diff a/... b/...` lines, handling quoted paths.
 */
function parseDiffGitHeader(line: string): { oldPath: string; newPath: string } {
	// Strip "diff --git " or "diff "
	const prefix = line.startsWith('diff --git ') ? 'diff --git ' : 'diff ';
	const rest = line.slice(prefix.length).trim();

	// Check if paths are quoted
	if (rest.startsWith('"')) {
		// First path is quoted: find matching end quote
		let endQuote = -1;
		for (let i = 1; i < rest.length; i++) {
			if (rest[i] === '"' && rest[i - 1] !== '\\') {
				endQuote = i;
				break;
			}
		}
		if (endQuote !== -1) {
			const firstRaw = rest.slice(0, endQuote + 1);
			const secondRaw = rest.slice(endQuote + 1).trim();
			return {
				oldPath: stripGitPrefix(firstRaw),
				newPath: stripGitPrefix(secondRaw),
			};
		}
	}

	// Unquoted paths separated by space
	const spaceIndex = rest.indexOf(' ');
	if (spaceIndex !== -1) {
		const first = rest.slice(0, spaceIndex);
		const second = rest.slice(spaceIndex + 1).trim();
		return {
			oldPath: stripGitPrefix(first),
			newPath: stripGitPrefix(second),
		};
	}

	return {
		oldPath: stripGitPrefix(rest),
		newPath: stripGitPrefix(rest),
	};
}
