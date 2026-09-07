import * as assert from 'assert';
import {
	parseHunkHeader,
	parsePatchText,
	stripGitPrefix,
	unquoteGitPath,
} from '../patchHunkParser';

suite('Patch hunk parser', () => {
	test('unquoteGitPath decodes quoted paths with spaces and escapes', () => {
		assert.strictEqual(unquoteGitPath('plain/path.ts'), 'plain/path.ts');
		assert.strictEqual(unquoteGitPath('"path with spaces/file.ts"'), 'path with spaces/file.ts');
		assert.strictEqual(unquoteGitPath('"path\\\"with\\\"quotes.ts"'), 'path"with"quotes.ts');
	});

	test('stripGitPrefix removes leading a/ and b/ but keeps /dev/null', () => {
		assert.strictEqual(stripGitPrefix('a/src/file.ts'), 'src/file.ts');
		assert.strictEqual(stripGitPrefix('b/src/file.ts'), 'src/file.ts');
		assert.strictEqual(stripGitPrefix('/dev/null'), '/dev/null');
		assert.strictEqual(stripGitPrefix('"a/path with space/file.ts"'), 'path with space/file.ts');
	});

	test('parseHunkHeader parses standard @@ headers', () => {
		const h1 = parseHunkHeader('@@ -10,4 +10,5 @@');
		assert.deepStrictEqual(h1, {
			oldStart: 10,
			oldLines: 4,
			newStart: 10,
			newLines: 5,
			heading: undefined,
		});

		const h2 = parseHunkHeader('@@ -1 +1 @@ function test()');
		assert.deepStrictEqual(h2, {
			oldStart: 1,
			oldLines: 1,
			newStart: 1,
			newLines: 1,
			heading: 'function test()',
		});
	});

	test('parses single-file unified diff with one hunk (LF and CRLF)', () => {
		const diffLF = [
			'diff --git a/src/math.ts b/src/math.ts',
			'index 1111111..2222222 100644',
			'--- a/src/math.ts',
			'+++ b/src/math.ts',
			'@@ -1,3 +1,3 @@',
			' function add(a: number, b: number) {',
			'-  return a - b;',
			'+  return a + b;',
			' }',
		].join('\n');

		const files = parsePatchText(diffLF);
		assert.strictEqual(files.length, 1);
		const file = files[0];
		assert.strictEqual(file.displayPath, 'src/math.ts');
		assert.strictEqual(file.isNewFile, false);
		assert.strictEqual(file.isDeletedFile, false);
		assert.strictEqual(file.hunks.length, 1);

		const hunk = file.hunks[0];
		assert.strictEqual(hunk.oldStart, 1);
		assert.strictEqual(hunk.oldLines, 3);
		assert.strictEqual(hunk.newStart, 1);
		assert.strictEqual(hunk.newLines, 3);
		assert.deepStrictEqual(hunk.deletedLines, ['  return a - b;']);
		assert.deepStrictEqual(hunk.addedLines, ['  return a + b;']);
		assert.strictEqual(
			hunk.patchOldText,
			'function add(a: number, b: number) {\n  return a - b;\n}',
		);
		assert.strictEqual(
			hunk.patchNewText,
			'function add(a: number, b: number) {\n  return a + b;\n}',
		);
		assert.deepStrictEqual(hunk.leadingContext, ['function add(a: number, b: number) {']);
		assert.deepStrictEqual(hunk.trailingContext, ['}']);

		// Test CRLF
		const diffCRLF = diffLF.replace(/\n/g, '\r\n');
		const filesCRLF = parsePatchText(diffCRLF);
		assert.strictEqual(filesCRLF.length, 1);
		assert.strictEqual(filesCRLF[0].hunks.length, 1);
		assert.deepStrictEqual(filesCRLF[0].hunks[0].addedLines, ['  return a + b;']);
	});

	test('parses multiple hunks in a single file', () => {
		const diff = [
			'diff --git a/src/user.ts b/src/user.ts',
			'--- a/src/user.ts',
			'+++ b/src/user.ts',
			'@@ -5,3 +5,3 @@',
			' ctx 1',
			'-del 1',
			'+add 1',
			' ctx 2',
			'@@ -20,3 +20,3 @@',
			' ctx 3',
			'-del 2',
			'+add 2',
			' ctx 4',
		].join('\n');

		const files = parsePatchText(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].hunks.length, 2);
		assert.deepStrictEqual(files[0].hunks[0].addedLines, ['add 1']);
		assert.deepStrictEqual(files[0].hunks[1].addedLines, ['add 2']);
	});

	test('handles new file diff (--- /dev/null)', () => {
		const diff = [
			'diff --git a/src/new.ts b/src/new.ts',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/src/new.ts',
			'@@ -0,0 +1,2 @@',
			'+export const value = 42;',
			'+export const name = "test";',
		].join('\n');

		const files = parsePatchText(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].isNewFile, true);
		assert.strictEqual(files[0].displayPath, 'src/new.ts');
		assert.strictEqual(files[0].hunks[0].addedLines.length, 2);
	});

	test('handles deleted file diff (+++ /dev/null)', () => {
		const diff = [
			'diff --git a/src/old.ts b/src/old.ts',
			'deleted file mode 100644',
			'--- a/src/old.ts',
			'+++ /dev/null',
			'@@ -1,2 +0,0 @@',
			'-line 1',
			'-line 2',
		].join('\n');

		const files = parsePatchText(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].isDeletedFile, true);
		assert.strictEqual(files[0].displayPath, 'src/old.ts');
		assert.strictEqual(files[0].hunks[0].deletedLines.length, 2);
	});

	test('handles renamed file diff', () => {
		const diff = [
			'diff --git a/src/prev.ts b/src/next.ts',
			'similarity index 100%',
			'rename from src/prev.ts',
			'rename to src/next.ts',
		].join('\n');

		const files = parsePatchText(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].isRename, true);
		assert.strictEqual(files[0].oldPath, 'src/prev.ts');
		assert.strictEqual(files[0].newPath, 'src/next.ts');
		assert.strictEqual(files[0].displayPath, 'src/next.ts');
	});

	test('detects binary diff and does not parse payload as text', () => {
		const diff = [
			'diff --git a/media/icon.png b/media/icon.png',
			'index 1111111..2222222 100644',
			'GIT binary patch',
			'literal 1234',
			'zcmV;40#N`0{',
			'',
		].join('\n');

		const files = parsePatchText(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].isBinary, true);
		assert.strictEqual(files[0].hunks.length, 0);
	});

	test('parses rejected hunks (.rej) output', () => {
		const rej = [
			'diff a/src/config.ts b/src/config.ts\t(rejected hunks)',
			'@@ -5,4 +5,4 @@',
			' const port = 3000;',
			'-const host = "localhost";',
			'+const host = "0.0.0.0";',
			' const debug = true;',
		].join('\n');

		const files = parsePatchText(rej);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].displayPath, 'src/config.ts');
		assert.strictEqual(files[0].hunks.length, 1);
		assert.strictEqual(files[0].hunks[0].addedLines[0], 'const host = "0.0.0.0";');
	});
});
