export type ConflictReason =
	| 'context-mismatch'
	| 'missing-file'
	| 'already-exists'
	| 'deleted-or-renamed'
	| 'unknown';

export interface ConflictFileDiagnostic {
	path: string;
	line?: number;
	reason: ConflictReason;
	friendlyReason: string;
	conciseReason: string;
	message?: string;
}

export interface PatchConflictDiagnostic {
	patchFileName: string;
	patchSha?: string;
	files: ConflictFileDiagnostic[];
	rawOutput: string;
}

export const friendlyReasonMap: Record<ConflictReason, string> = {
	'context-mismatch': 'Current file contents differ from the version this patch expected.',
	'missing-file': 'The patch expects this file to exist, but it is missing.',
	'already-exists': 'The patch is trying to add a file that already exists.',
	'deleted-or-renamed': 'The patch references a path that may have been deleted or renamed.',
	'unknown': 'Git could not apply this part of the patch.',
};

export const conciseReasonMap: Record<ConflictReason, string> = {
	'context-mismatch': 'Context mismatch',
	'missing-file': 'File missing',
	'already-exists': 'File already exists',
	'deleted-or-renamed': 'File deleted or renamed',
	'unknown': 'Apply check failed',
};

export function parseConflictDiagnostics(
	rawOutput: string,
	patchFileName: string,
	patchSha?: string,
): PatchConflictDiagnostic {
	const lines = rawOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const fileMap = new Map<string, {
		line?: number;
		reason: ConflictReason;
		message?: string;
	}>();

	for (const line of lines) {
		// Pattern 1: error: patch failed: src/foo.ts:42 or patch failed: src/foo.ts:42
		let match = /(?:error:\s*)?patch failed:\s*([^:]+):(\d+)/i.exec(line);
		if (match) {
			const path = match[1].trim();
			const lineNumber = Number(match[2]);
			const existing = fileMap.get(path);
			fileMap.set(path, {
				line: lineNumber,
				reason: 'context-mismatch',
				message: line,
			});
			continue;
		}

		// Pattern 2: error: src/foo.ts: patch does not apply or src/foo.ts: patch does not apply
		match = /(?:error:\s*)?([^:]+):\s*patch does not apply/i.exec(line);
		if (match) {
			const path = match[1].trim();
			const existing = fileMap.get(path);
			if (!existing || existing.reason === 'unknown') {
				fileMap.set(path, {
					line: existing?.line,
					reason: 'context-mismatch',
					message: line,
				});
			}
			continue;
		}

		// Pattern 3: error: src/foo.ts: No such file or directory or does not exist in index
		match = /(?:error:\s*)?([^:]+):\s*(?:No such file or directory|does not exist in (?:index|working directory))/i.exec(line);
		if (match) {
			const path = match[1].trim();
			fileMap.set(path, {
				reason: 'missing-file',
				message: line,
			});
			continue;
		}

		// Pattern 4: error: src/foo.ts: already exists in working directory
		match = /(?:error:\s*)?([^:]+):\s*already exists in (?:working directory|index)/i.exec(line);
		if (match) {
			const path = match[1].trim();
			fileMap.set(path, {
				reason: 'already-exists',
				message: line,
			});
			continue;
		}

		// Pattern 5: error: src/foo.ts: deletion of file ... or renamed
		match = /(?:error:\s*)?([^:]+):\s*(?:deletion failed|cannot delete|file was renamed)/i.exec(line);
		if (match) {
			const path = match[1].trim();
			fileMap.set(path, {
				reason: 'deleted-or-renamed',
				message: line,
			});
			continue;
		}

		// Generic pattern: error: <path>: <message>
		match = /^error:\s*([^:\s][^:]*):\s*(.+)$/i.exec(line);
		if (match) {
			const path = match[1].trim();
			const message = match[2].trim();
			if (!fileMap.has(path)) {
				fileMap.set(path, {
					reason: 'unknown',
					message: line,
				});
			}
		}
	}

	const files: ConflictFileDiagnostic[] = Array.from(fileMap.entries()).map(
		([path, info]) => ({
			path,
			line: info.line,
			reason: info.reason,
			friendlyReason: friendlyReasonMap[info.reason],
			conciseReason: info.line !== undefined && info.reason === 'context-mismatch'
				? `Context mismatch near line ${info.line}`
				: conciseReasonMap[info.reason],
			message: info.message,
		}),
	);

	return {
		patchFileName,
		patchSha,
		files,
		rawOutput,
	};
}

export function formatConflictDetailsDocument(diagnostic: PatchConflictDiagnostic): string {
	const lines: string[] = [
		'Patch Conflict Details',
		diagnostic.patchFileName,
		'',
		'STATUS',
		'CONFLICT',
		'',
		'AFFECTED FILES',
	];

	if (diagnostic.files.length === 0) {
		lines.push('No specific conflicting files could be parsed from Git diagnostics.');
	} else {
		for (let i = 0; i < diagnostic.files.length; i++) {
			const file = diagnostic.files[i];
			lines.push('');
			lines.push(`${i + 1}. ${file.path}`);
			lines.push(`   Reason: ${file.friendlyReason}`);
			if (file.line !== undefined) {
				lines.push(`   Git location: around line ${file.line}`);
			}
		}
	}

	lines.push(
		'',
		'WHAT THIS MEANS',
		'',
		'The patch was created against different file contents than those currently',
		'present in this project.',
		'',
		'No files have been modified.',
		'',
		'RAW GIT DIAGNOSTICS',
		'',
		diagnostic.rawOutput.trim() || '(no output reported by Git)',
		'',
	);

	return lines.join('\n');
}

export function formatConflictClipboardReport(diagnostic: PatchConflictDiagnostic): string {
	const lines: string[] = [
		'Patch Transfer Conflict Report',
		`Patch: ${diagnostic.patchFileName}`,
	];

	if (diagnostic.patchSha) {
		lines.push(`SHA-256: ${diagnostic.patchSha}`);
	}

	lines.push('');

	if (diagnostic.files.length === 0) {
		lines.push('(No specific conflicting files parsed)');
	} else {
		for (const file of diagnostic.files) {
			lines.push(file.path);
			lines.push(`- ${file.conciseReason}`);
			lines.push('');
		}
	}

	lines.push('Git:');
	lines.push(diagnostic.rawOutput.trim() || '(no output reported by Git)');

	return `${lines.join('\n')}\n`;
}
