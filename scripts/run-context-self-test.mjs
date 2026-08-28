import assert from 'node:assert/strict';
import { parseRunContract, parseStoredRunContract } from '../shared/run-contract.mjs';

const fullScope = { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] };
const targetedScope = { qualifier: 'TARGETED', pluginIds: ['platform-routes-content'], auditIds: ['CONTENT-002'], areas: ['content'] };

assert.deepEqual(parseRunContract({
  schemaVersion: 1,
  mode: 'comparative',
  productionUrl: 'https://quitting7oh.org/',
  candidateUrl: 'https://beta.quitting7oh-org.pages.dev/',
  targetIds: ['production-mobile-chromium', 'candidate-mobile-chromium'],
  scope: fullScope,
}), {
  schemaVersion: 1,
  mode: 'comparative',
  productionUrl: 'https://quitting7oh.org',
  candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
  targetIds: ['production-mobile-chromium', 'candidate-mobile-chromium'],
  scope: fullScope,
});

assert.deepEqual(parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev/',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
}), {
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
});

assert.deepEqual(parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev/',
  deploymentRole: 'preview',
  certificatePolicy: 'preview-bypass',
  targetIds: ['single-site-mobile-chromium'],
  scope: targetedScope,
}).scope, targetedScope);

assert.equal(parseStoredRunContract({
  productionUrl: 'https://quitting7oh.org',
  candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
}).mode, 'comparative-legacy');

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  productionUrl: 'https://quitting7oh.org',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
}), /must not contain productionUrl/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://quitting7oh.org',
  deploymentRole: 'production',
  certificatePolicy: 'preview-bypass',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
}), /confirmed Preview/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'comparative',
  productionUrl: 'https://quitting7oh.org',
  candidateUrl: 'https://quitting7oh.org/',
  targetIds: ['candidate-mobile-chromium'],
  scope: fullScope,
}), /must be distinct/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://user:secret@example.com',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
}), /must not contain credentials/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium', 'single-site-mobile-chromium'],
  scope: fullScope,
}), /must not contain duplicates/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-ish',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
}), /mode must be comparative or single-site/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  productionUrl: 'https://quitting7oh.org',
  candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
  targetIds: ['candidate-mobile-chromium'],
  scope: fullScope,
}), /mode must be comparative or single-site/,
'Legacy mode inference is allowed only for stored documents.');

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: { ...fullScope, auditIds: ['CONTENT-002'] },
}), /FULL scope must not contain/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: [], areas: [] },
}), /TARGETED scope must select/);

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
  candidateUrl: undefined,
}), /unsupported fields|must not contain candidateUrl/,
'Even undefined cross-mode fields must not be accepted as part of a new run contract.');

assert.throws(() => parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.quitting7oh-org.pages.dev',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: { ...fullScope, hiddenFilter: 'CONTENT-002' },
}), /scope contains unsupported fields/);

process.stdout.write('Run-context self-test passed: comparative, legacy, and Single-site contracts remain discriminated and fail closed.\n');
