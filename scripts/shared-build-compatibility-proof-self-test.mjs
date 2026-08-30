import assert from 'node:assert/strict';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { createSharedBuildCompatibilityProof } from './create-shared-build-compatibility-proof.mjs';

const imageDigest = `sha256:${'a'.repeat(64)}`;
const imageRevision = `image:sha256:${'b'.repeat(64)}`;
const workspaceRevision = `workspace:sha256:${'b'.repeat(64)}`;
const report = Object.freeze({
  schemaVersion: 1,
  kind: 'shared-docker-resilience-proof',
  authority: 'AUTHORITATIVE',
  generatedAt: '2026-08-30T20:00:00.000Z',
  source: { imageId: imageDigest, imageRevision, workspaceRevision },
  fixture: 'validator-owned-content',
});
let validationCalls = 0;
const validate = (value, options) => {
  validationCalls += 1;
  assert.equal(value, report);
  assert.equal(options.expectedWorkspaceRevision, workspaceRevision);
  return value;
};

const proof = createSharedBuildCompatibilityProof({
  resilienceProof: report,
  targetBuildIdentity: `build:${imageDigest}`,
  expectedWorkspaceRevision: workspaceRevision,
  validate,
});
assert.equal(validationCalls, 1);
assert.deepEqual(proof, {
  schemaVersion: 1,
  kind: 'shared-build-compatibility-proof',
  targetBuildIdentity: `build:${imageDigest}`,
  runnerRevision: `sha256:${'b'.repeat(64)}`,
  imageDigest,
  validationDigest: canonicalDigest(report),
  generatedAt: report.generatedAt,
  digest: proof.digest,
});
const { digest, ...body } = proof;
assert.equal(digest, canonicalDigest(body));
assert.throws(() => createSharedBuildCompatibilityProof({
  resilienceProof: report,
  targetBuildIdentity: 'build:mutable-tag',
  expectedWorkspaceRevision: workspaceRevision,
  validate,
}), /validated immutable image identity/u);
assert.equal(validationCalls, 2);

process.stdout.write('Shared build compatibility-proof self-test passed: authoritative validation binds target identity, runner revision, image digest, and validation digest.\n');
