// D96: the test writer owns every test file: *.test.ts(x), *.spec.ts(x),
// *.e2e.ts (D177),
// anything in a tests/ or e2e/ folder, and test data, which lives in
// tests/fixtures/ (saved AI answers included).
const TEST_FILE = /\.(?:test|spec|e2e)\.tsx?$/i;
const TEST_DIR = /(?:^|\/)(?:tests|e2e)(?:\/|$)/;

export function isTestPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return TEST_FILE.test(p) || TEST_DIR.test(p);
}
