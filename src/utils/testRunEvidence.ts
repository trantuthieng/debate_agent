/**
 * How many tests a runner actually executed, read from its own summary
 * (audit C04). A test command that exits 0 after running nothing is not
 * evidence that anything works.
 *
 * `executed` is null when no known summary line is present: the count is
 * then unknown, which callers must not treat as zero.
 */
export interface TestRunCount { executed: number | null; skipped: number; runner: string | null }

const num = (value: string | undefined): number => (value ? Number(value) : 0);

export function countExecutedTests(output: string): TestRunCount {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  let m: RegExpMatchArray | null;

  // node:test (spec reporter "ℹ tests 3", TAP "# tests 3")
  if ((m = text.match(/^(?:ℹ|#)\s*tests\s+(\d+)\s*$/m))) {
    const skipped = num(text.match(/^(?:ℹ|#)\s*skip(?:ped)?\s+(\d+)\s*$/m)?.[1]) + num(text.match(/^(?:ℹ|#)\s*todo\s+(\d+)\s*$/m)?.[1]);
    return { executed: Math.max(0, num(m[1]) - skipped), skipped, runner: 'node:test' };
  }
  // Jest: "Tests:       1 skipped, 2 passed, 3 total"
  if ((m = text.match(/^\s*Tests:\s+(.*?)(\d+) total/m))) {
    const skipped = num(m[1].match(/(\d+) skipped/)?.[1]) + num(m[1].match(/(\d+) todo/)?.[1]);
    return { executed: Math.max(0, num(m[2]) - skipped), skipped, runner: 'jest' };
  }
  // Vitest: "Tests  2 passed | 1 skipped (3)"
  if ((m = text.match(/^\s*Tests\s+([^\n]*?)\((\d+)\)\s*$/m))) {
    const skipped = num(m[1].match(/(\d+) skipped/)?.[1]) + num(m[1].match(/(\d+) todo/)?.[1]);
    return { executed: Math.max(0, num(m[2]) - skipped), skipped, runner: 'vitest' };
  }
  // Mocha: "2 passing", "1 failing", "3 pending"
  if ((m = text.match(/^\s*(\d+) passing\b/m))) {
    const failing = num(text.match(/^\s*(\d+) failing\b/m)?.[1]);
    return { executed: num(m[1]) + failing, skipped: num(text.match(/^\s*(\d+) pending\b/m)?.[1]), runner: 'mocha' };
  }
  // pytest: "=== 3 passed, 1 skipped in 0.1s ===" / "no tests ran"
  if (/=+ no tests ran/i.test(text) || /collected 0 items/.test(text)) { return { executed: 0, skipped: 0, runner: 'pytest' }; }
  if ((m = text.match(/^=+ (.*?\b(?:passed|failed|error)\b.*?) in [\d.]+s/m))) {
    const count = (word: string) => num(m![1].match(new RegExp(`(\\d+) ${word}`))?.[1]);
    return { executed: count('passed') + count('failed') + count('errors?'), skipped: count('skipped'), runner: 'pytest' };
  }
  if (/No tests found|No test files found|no test specified|No test suite found/i.test(text)) {
    return { executed: 0, skipped: 0, runner: null };
  }
  return { executed: null, skipped: 0, runner: null };
}

/** Removes // and /* *\/ comments (strings are not parsed; good enough to spot empty test bodies). */
export function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
