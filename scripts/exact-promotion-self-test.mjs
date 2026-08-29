import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { sealAuditedCandidateDeployment } from '../shared/release-artifact-contract.mjs';
import { buildReleaseArtifactManifest } from './lib/release-artifact.mjs';
import { executeExactPromotion } from './lib/exact-promotion.mjs';
import { runExactPromotionCommand } from './run-exact-promotion.mjs';
import { formatSharedReleaseCiResult } from './run-shared-release-ci.mjs';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const root = await mkdtemp(path.join(tmpdir(), 'exact-promotion-'));

function finalSubject(mode = 'single-site') {
  const targets = mode === 'single-site'
    ? [{ role: 'audited', origin: 'https://beta.example.test' }]
    : [
      { role: 'candidate', origin: 'https://beta.example.test' },
      { role: 'production', origin: 'https://www.example.test' },
    ];
  const targetIds = mode === 'single-site' ? ['audited-desktop'] : ['candidate-desktop', 'production-desktop'];
  const workItems = targetIds.map((targetId, index) => ({
    id: `work-${index}`, definitionId: 'VISUAL-001', targetId,
    targetRole: targets[index].role,
  }));
  const core = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'target-preflight-set', value: D1 },
    targets,
    mode,
    requestedAuthority: {
      qualifier: 'FULL',
      scope: { features: ['site'], definitions: ['VISUAL-001'], targets: targetIds, knownLimits: [] },
    },
    revisions: { runner: D1, plugins: D1, targets: D1, configuration: D1 },
    environmentIdentity: D2,
    certificatePolicy: 'strict',
  });
  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: core.digest,
    workItems,
    oracleExecutions: [{ id: 'oracle-visual', definitionId: 'VISUAL-001', requiredWorkItemIds: workItems.map(({ id }) => id) }],
    contextWorkItemIds: [],
  });
  return sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore: core,
    executionManifest,
    grantedAuthority: core.requestedAuthority,
    coverageBasis: { selectedDefinitions: ['VISUAL-001'], selectedTargets: targetIds, excludedAsNotApplicable: [] },
    deploymentIdentityRecheck: core.deploymentIdentity,
  });
}

function ciResult(subject = finalSubject()) {
  return formatSharedReleaseCiResult('shared-release-ci-request-0001', {
    stage: 'final',
    operationId: 'a'.repeat(64),
    runId: `run-${'a'.repeat(32)}`,
    run: { finalSubject: subject },
    publication: {
      digest: D1,
      finalSubjectDigest: subject.digest,
      decisionRevision: 4,
      runRevision: 9,
      decision: {
        subjectStage: 'final',
        code: 'RELEASE_READY',
        ready: true,
        grantedAuthority: 'FULL',
        executionManifestDigest: subject.executionManifestDigest,
      },
    },
    assertionExpected: {
      subjectDigest: subject.digest,
      authority: 'FULL',
      executionSetDigest: subject.executionManifestDigest,
      runRevision: 9,
      decisionRevision: 4,
    },
  });
}

function harness({ failAssert = false, failConsume = false, failPrepare = false } = {}) {
  const calls = [];
  let providerInput = null;
  const claimToken = `amtp.${'a'.repeat(32)}.${'s'.repeat(43)}`;
  return {
    calls,
    get providerInput() { return providerInput; },
    client: {
      async assertRelease(input) {
        calls.push('assert');
        if (failAssert) throw Object.assign(new Error('assert failed'), { code: 'PROMOTION_STALE' });
        return {
          token: claimToken, expiresAt: '2026-08-29T21:00:00.000Z', runId: input.runId,
          subjectDigest: input.expected.subjectDigest, authority: input.expected.authority,
          runRevision: input.expected.runRevision, decisionRevision: input.expected.decisionRevision,
        };
      },
      async consumePromotion(input) {
        calls.push('consume');
        assert.equal(input.token, claimToken);
        if (failConsume) throw Object.assign(new Error('consume failed'), { code: 'PROMOTION_CLAIM_STALE' });
        return {
          consumed: true, claimId: 'a'.repeat(32), runId: input.runId,
          subjectDigest: input.expectedSubjectDigest, publicationDigest: D1,
          consumedAt: '2026-08-29T20:01:00.000Z', receiptDigest: D2,
        };
      },
    },
    provider: {
      async prepare(input) {
        calls.push('prepare');
        if (failPrepare) throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
        assert.equal(input.production.projectName, 'quitting7oh-org');
      },
      async deploy(input) {
        calls.push('deploy');
        providerInput = structuredClone(input);
        assert.equal('token' in input, false, 'promotion claim must never cross the provider boundary');
        return {
          schemaVersion: 1, provider: 'cloudflare-pages', deploymentId: 'production-deployment-123',
          deploymentUrl: 'https://production-deployment-123.quitting7oh-org.pages.dev',
        };
      },
    },
  };
}

try {
  const artifactRoot = path.join(root, 'site');
  await mkdir(artifactRoot);
  await writeFile(path.join(artifactRoot, 'index.html'), '<h1>exact</h1>\n');
  const artifactManifest = await buildReleaseArtifactManifest(artifactRoot);
  const candidateDeployment = sealAuditedCandidateDeployment({
    schemaVersion: 1,
    provider: 'cloudflare-pages', accountId: 'account-123', projectName: 'quitting7oh-org-beta',
    deploymentId: 'candidate-deployment-123',
    deploymentUrl: 'https://candidate-deployment-123.quitting7oh-org-beta.pages.dev',
    auditedOrigin: 'https://beta.example.test',
    artifactManifestDigest: artifactManifest.digest,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    createdAt: '2026-08-29T20:00:00.000Z',
  });
  const base = {
    ciResult: ciResult(), artifactRoot, artifactManifest, candidateDeployment,
    projectId: 'quitting7oh-release',
    production: { accountId: 'account-123', projectName: 'quitting7oh-org', branch: 'main' },
    sourceRevision: candidateDeployment.sourceRevision,
    requestId: 'exact-promotion-request-0001',
  };

  const coreStageResult = structuredClone(base.ciResult);
  coreStageResult.stage = 'core';
  coreStageResult.finalSubject = null;
  coreStageResult.executionSetDigest = null;
  coreStageResult.decision = {
    ...coreStageResult.decision,
    code: 'NOT_READY_INCOMPLETE_EXECUTION',
    ready: false,
    authority: null,
  };
  coreStageResult.assertionExpected = null;
  const rejectedCoreStage = harness();
  await assert.rejects(
    executeExactPromotion({ ...base, ciResult: coreStageResult, client: rejectedCoreStage.client, provider: rejectedCoreStage.provider }),
    (error) => error?.code === 'EXACT_PROMOTION_CI_RESULT_INVALID',
    'core-stage CI results must never reach promotion',
  );
  assert.deepEqual(rejectedCoreStage.calls, []);

  const successful = harness();
  const receipt = await executeExactPromotion({ ...base, client: successful.client, provider: successful.provider });
  assert.deepEqual(successful.calls, ['prepare', 'assert', 'consume', 'deploy']);
  assert.equal(receipt.artifactManifestDigest, artifactManifest.digest);
  assert.equal(receipt.claimReceiptDigest, D2);
  assert.equal(receipt.subjectDigest, base.ciResult.subjectDigest);
  assert.equal(receipt.provider.deploymentId, 'production-deployment-123');
  assert.equal(successful.providerInput.artifactManifest.digest, artifactManifest.digest);

  const comparative = harness();
  await executeExactPromotion({
    ...base, ciResult: ciResult(finalSubject('comparative')),
    client: comparative.client, provider: comparative.provider,
  });
  assert.deepEqual(comparative.calls, ['prepare', 'assert', 'consume', 'deploy']);

  const commandRoot = path.join(root, 'command');
  await mkdir(commandRoot);
  const deliveryToken = `amt.delivery.${'d'.repeat(40)}`;
  const cloudflareToken = `cloudflare-${'c'.repeat(40)}`;
  const commandFiles = {
    delivery: path.join(commandRoot, 'delivery.token'), cloudflare: path.join(commandRoot, 'cloudflare.token'),
    ci: path.join(commandRoot, 'ci.json'), manifest: path.join(commandRoot, 'manifest.json'),
    candidate: path.join(commandRoot, 'candidate.json'), result: path.join(commandRoot, 'result.json'),
  };
  for (const [file, value] of [
    [commandFiles.delivery, deliveryToken], [commandFiles.cloudflare, cloudflareToken],
    [commandFiles.ci, JSON.stringify(base.ciResult)], [commandFiles.manifest, JSON.stringify(artifactManifest)],
    [commandFiles.candidate, JSON.stringify(candidateDeployment)],
  ]) {
    await writeFile(file, `${value}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  const commandHarness = harness();
  const commandRequests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      commandRequests.push({ url: request.url, idempotencyKey: request.headers['idempotency-key'], body });
      assert.equal(request.headers.authorization, `Bearer ${deliveryToken}`);
      response.setHeader('content-type', 'application/json');
      const data = request.url.endsWith('/release/assert')
        ? {
          token: `amtp.${'a'.repeat(32)}.${'s'.repeat(43)}`, expiresAt: '2026-08-29T21:00:00.000Z',
          runId: base.ciResult.runId, subjectDigest: base.ciResult.subjectDigest, authority: 'FULL',
          runRevision: 9, decisionRevision: 4,
        }
        : {
          consumed: true, claimId: 'a'.repeat(32), runId: base.ciResult.runId,
          subjectDigest: base.ciResult.subjectDigest, publicationDigest: D1,
          consumedAt: '2026-08-29T20:01:00.000Z', receiptDigest: D2,
        };
      response.end(JSON.stringify({ schemaVersion: 1, data }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    const output = [];
    await runExactPromotionCommand([
      '--server', `http://127.0.0.1:${address.port}`,
      '--delivery-token-file', commandFiles.delivery, '--cloudflare-token-file', commandFiles.cloudflare,
      '--ci-result-file', commandFiles.ci, '--artifact-root', artifactRoot,
      '--artifact-manifest-file', commandFiles.manifest, '--candidate-file', commandFiles.candidate,
      '--project-id', base.projectId, '--production-account-id', base.production.accountId,
      '--production-project', base.production.projectName, '--production-branch', base.production.branch,
      '--source-revision', base.sourceRevision, '--request-id', base.requestId, '--result-file', commandFiles.result,
    ], {
      stdout: { write: (value) => output.push(String(value)) },
      providerFactory: (configuration) => {
        assert.equal(configuration.apiToken, cloudflareToken);
        assert.equal(configuration.accountId, base.production.accountId);
        return commandHarness.provider;
      },
    });
    assert.deepEqual(commandHarness.calls, ['prepare', 'deploy']);
    assert.deepEqual(commandRequests.map(({ idempotencyKey }) => idempotencyKey), [
      `${base.requestId}:assert`, `${base.requestId}:consume`,
    ]);
    assert.equal(commandRequests[1].body.token, `amtp.${'a'.repeat(32)}.${'s'.repeat(43)}`);
    const retained = `${await readFile(commandFiles.result, 'utf8')}\n${output.join('')}`;
    assert.doesNotMatch(retained, new RegExp(deliveryToken, 'u'));
    assert.doesNotMatch(retained, new RegExp(cloudflareToken, 'u'));
    assert.doesNotMatch(retained, /amtp\./u);
    assert.equal((await stat(commandFiles.result)).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  for (const [label, overrides, expectedCalls] of [
    ['candidate origin', { candidateDeployment: { ...candidateDeployment, auditedOrigin: 'https://wrong.example.test' } }, []],
    ['candidate artifact', { candidateDeployment: { ...candidateDeployment, artifactManifestDigest: D2 } }, []],
    ['source revision', { sourceRevision: 'changed-source' }, []],
    ['provider preflight', { harness: { failPrepare: true } }, ['prepare']],
    ['claim assertion', { harness: { failAssert: true } }, ['prepare', 'assert']],
    ['claim consumption', { harness: { failConsume: true } }, ['prepare', 'assert', 'consume']],
  ]) {
    const current = harness(overrides.harness);
    await assert.rejects(executeExactPromotion({
      ...base, ...overrides, harness: undefined, client: current.client, provider: current.provider,
    }), undefined, label);
    assert.deepEqual(current.calls, expectedCalls, `${label} must not cross the next authority or provider boundary`);
  }

  await writeFile(path.join(artifactRoot, 'index.html'), '<h1>mutated</h1>\n');
  const changed = harness();
  await assert.rejects(
    executeExactPromotion({ ...base, client: changed.client, provider: changed.provider }),
    (error) => error?.code === 'RELEASE_ARTIFACT_CHANGED',
  );
  assert.deepEqual(changed.calls, []);

  console.log('Exact promotion self-test passed: audited candidate bytes, live claim consumption, and provider delivery are ordered and fail closed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
