import * as assert from 'assert';
import { applyHunkReplacement, matchHunkInTarget } from '../patchHunkMatcher';
import { parsePatchText } from '../patchHunkParser';

suite('Patch hunk matcher', () => {
	test('matches unique exact old hunk lines', () => {
		const patch = [
			'diff --git a/src/index.ts b/src/index.ts',
			'--- a/src/index.ts',
			'+++ b/src/index.ts',
			'@@ -2,3 +2,3 @@',
			' const a = 1;',
			'-const b = 2;',
			'+const b = 20;',
			' const c = 3;',
		].join('\n');

		const target = [
			'// header',
			'const a = 1;',
			'const b = 2;',
			'const c = 3;',
			'// footer',
		].join('\n');

		const file = parsePatchText(patch)[0];
		const match = matchHunkInTarget(target, file.hunks[0]);

		assert.strictEqual(match.safe, true);
		assert.strictEqual(match.startLine, 1);
		assert.strictEqual(match.endLine, 4);
		assert.strictEqual(match.currentText, 'const a = 1;\nconst b = 2;\nconst c = 3;');

		const replaced = applyHunkReplacement(target, match, file.hunks[0]);
		assert.strictEqual(
			replaced,
			['// header', 'const a = 1;', 'const b = 20;', 'const c = 3;', '// footer'].join('\n'),
		);
	});

	test('matches via unique surrounding context when middle content differs', () => {
		const patch = [
			'diff --git a/src/index.ts b/src/index.ts',
			'--- a/src/index.ts',
			'+++ b/src/index.ts',
			'@@ -2,3 +2,3 @@',
			' function calculate() {',
			'-  return 10;',
			'+  return 42;',
			' }',
		].join('\n');

		// Target has altered middle line
		const target = [
			'import { utils } from "./utils";',
			'function calculate() {',
			'  return 999; // locally modified',
			'}',
			'export default calculate;',
		].join('\n');

		const file = parsePatchText(patch)[0];
		const match = matchHunkInTarget(target, file.hunks[0]);

		assert.strictEqual(match.safe, true);
		assert.strictEqual(match.startLine, 1);
		assert.strictEqual(match.endLine, 4);
		assert.ok(match.currentText.includes('999'));

		const replaced = applyHunkReplacement(target, match, file.hunks[0]);
		assert.ok(replaced.includes('return 42;'));
		assert.ok(!replaced.includes('999'));
	});

	test('rejects ambiguous duplicate matches without guessing', () => {
		const patch = [
			'diff --git a/src/index.ts b/src/index.ts',
			'--- a/src/index.ts',
			'+++ b/src/index.ts',
			'@@ -1,3 +1,3 @@',
			' item',
			'-old',
			'+new',
			' end',
		].join('\n');

		const target = [
			'item',
			'old',
			'end',
			'// middle',
			'item',
			'old',
			'end',
		].join('\n');

		const file = parsePatchText(patch)[0];
		const match = matchHunkInTarget(target, file.hunks[0]);

		assert.strictEqual(match.safe, false);
		assert.ok(match.unsafeReason?.includes('Multiple matching regions'));
	});

	test('rejects when no safe match can be identified', () => {
		const patch = [
			'diff --git a/src/index.ts b/src/index.ts',
			'--- a/src/index.ts',
			'+++ b/src/index.ts',
			'@@ -1,3 +1,3 @@',
			' totally_missing_prefix',
			'-old',
			'+new',
			' totally_missing_suffix',
		].join('\n');

		const target = 'completely different content\nno match here\n';

		const file = parsePatchText(patch)[0];
		const match = matchHunkInTarget(target, file.hunks[0]);

		assert.strictEqual(match.safe, false);
		assert.ok(match.unsafeReason?.includes('Could not safely locate'));
	});

	test('preserves CRLF line endings when applying hunk replacement', () => {
		const patch = [
			'diff --git a/src/crlf.ts b/src/crlf.ts',
			'--- a/src/crlf.ts',
			'+++ b/src/crlf.ts',
			'@@ -1,3 +1,3 @@',
			' alpha',
			'-beta',
			'+BETA',
			' gamma',
		].join('\n');

		const targetCRLF = 'alpha\r\nbeta\r\ngamma\r\n';
		const file = parsePatchText(patch)[0];
		const match = matchHunkInTarget(targetCRLF, file.hunks[0]);

		assert.strictEqual(match.safe, true);
		const replaced = applyHunkReplacement(targetCRLF, match, file.hunks[0]);
		assert.strictEqual(replaced, 'alpha\r\nBETA\r\ngamma\r\n');
	});
});
