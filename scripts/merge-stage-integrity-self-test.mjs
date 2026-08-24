import assert from 'node:assert/strict';
import { mergeResultsAreUsable, mergeStageIntegrityFailures } from './lib/merge-stage-integrity.mjs';

const stage = (overrides = {}) => ({
  name: 'merge-reports',
  exitCode: 0,
  signal: null,
  ...overrides,
});

assert.equal(mergeResultsAreUsable(stage(), true), true);
assert.equal(
  mergeResultsAreUsable(stage({ exitCode: 1 }), true),
  true,
  'Playwright browser findings may exit 1 only when a fresh complete result exists.',
);
for (const mutation of [
  stage({ exitCode: 2 }),
  stage({ exitCode: 127 }),
  stage({ exitCode: 1, signal: 'SIGTERM' }),
  stage({ exitCode: 0, signal: 'SIGKILL' }),
]) {
  assert.equal(mergeResultsAreUsable(mutation, true), false, JSON.stringify(mutation));
  assert.ok(mergeStageIntegrityFailures(mutation, true).length > 0);
}
assert.equal(mergeResultsAreUsable(stage(), false), false);
assert.match(mergeStageIntegrityFailures(stage(), false).join('; '), /fresh structured results/);

process.stdout.write('Merge-stage integrity self-test passed: signals, abnormal exit codes, and missing fresh results fail closed while an ordinary Playwright finding remains diagnostic.\n');
