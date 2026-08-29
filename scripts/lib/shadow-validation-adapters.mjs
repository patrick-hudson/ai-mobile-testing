import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileCanonicalExecutionGraph,
  compileIncompleteWorkRekick,
  compileSingleSiteInventoryBarrier,
  completeSingleSiteInventoryBarrier,
} from '../../shared/execution-graph-compiler.mjs';
import {
  parseExecutionManifest,
  sealOracleResult,
  sealProductFailureSignature,
  sealWorkItemResult,
} from '../../shared/execution-contract.mjs';
import {
  assertConsumableReleaseDecision,
  deriveReleaseDecision,
  parseReleaseDecision,
} from '../../shared/release-decision.mjs';
import { appendVisualDisposition, projectSharedReleaseView } from '../../shared/release-projection.mjs';
import { sealReleaseSubjectCore } from '../../shared/release-subject.mjs';
import { compileDefinitionCoverageManifest } from '../../shared/run-compiler.mjs';
import {
  SHADOW_COMPARATIVE_FAILURE_SCENARIOS,
  buildPreRegisteredShadowMatrix,
} from '../../shared/shadow-validation-fixtures.mjs';
import { parsePublicationEnvelope } from '../../shared/publication-envelope.mjs';
import { parseChecklistRelease } from './release-truth.mjs';
import {
  cancelJob,
  claimJob,
  openJobQueue,
  publishAttemptDocument,
  sha256,
  submitJob,
} from './job-queue.mjs';

const FIXTURE_TIMESTAMP = '2026-08-29T12:00:00.000Z';
const CANDIDATE_ORIGIN = 'https://beta.example.test';
const PRODUCTION_ORIGIN = 'https://example.test';
const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const BASELINE_FAILURE_SIGNATURE = sealProductFailureSignature({
  schemaVersion: 1,
  assertionIdentities: ['assertion:shadow-product-contract:baseline'],
  findingIdentities: ['finding:shadow-product-contract:baseline'],
});
const CANDIDATE_FAILURE_SIGNATURE = sealProductFailureSignature({
  schemaVersion: 1,
  assertionIdentities: ['assertion:shadow-product-contract:candidate'],
  findingIdentities: ['finding:shadow-product-contract:candidate'],
});

const RESULT_TO_WORK_OUTCOME = Object.freeze({
  COMPLETED_PASS: 'completed_pass',
  COMPLETED_PRODUCT_FAILURE: 'completed_product_failure',
  OPERATIONAL_FAILURE: 'operational_failure',
  CANCELLED: 'cancelled',
  INCOMPLETE_UNKNOWN: 'incomplete_unknown',
});

function receipt(observe, caseId, side, productionFunction, detail = null) {
  observe?.(Object.freeze({ caseId, side, productionFunction, detail }));
}

function fixtureCatalog(source, { includeUnselected = false } = {}) {
  const definitions = source.selectedDefinitions.map((id, index) => ({
    id,
    area: source.selectedFeatures[Math.min(index, source.selectedFeatures.length - 1)],
    title: `Shadow definition ${id}`,
    severity: 'P1',
    manual: false,
    singleSiteClassification: 'standalone-compatible',
    expected: `The ${id} Product Oracle passes.`,
  }));
  if (source.caseId === 'AE15') {
    definitions.push({
      id: 'comparison-only-definition',
      area: 'migration',
      title: 'Comparison-only shadow definition',
      severity: 'P1',
      manual: false,
      singleSiteClassification: 'comparison-only',
      expected: 'Candidate and production remain comparable.',
    });
  }
  if (includeUnselected) {
    definitions.push({
      id: 'shadow-unselected-definition',
      area: 'shadow-unselected',
      title: 'Unselected shadow definition',
      severity: 'P2',
      manual: false,
      singleSiteClassification: 'standalone-compatible',
      expected: 'This definition remains outside the targeted scope.',
    });
  }

  const cases = source.requiredExecutionIds.map((semanticId, index) => {
    const definition = definitions[index % source.selectedDefinitions.length];
    return {
      caseId: `shadow:${source.caseId}:${index + 1}`,
      auditId: definition.id,
      entrySpec: 'tests/shadow-production-adapter.spec.ts',
      applicability: 'all',
      supportedModes: [source.mode],
      supportedProjects: [...source.selectedTargets],
      oracleVariants: source.mode === 'single-site'
        ? { singleSite: `shadow-single:${semanticId}` }
        : { comparative: `shadow-comparative:${semanticId}` },
    };
  });
  if (includeUnselected) {
    cases.push({
      caseId: `shadow:${source.caseId}:unselected`,
      auditId: 'shadow-unselected-definition',
      entrySpec: 'tests/shadow-production-adapter.spec.ts',
      applicability: 'all',
      supportedModes: ['single-site'],
      supportedProjects: [...source.selectedTargets],
      oracleVariants: { singleSite: 'shadow-unselected' },
    });
  }
  return {
    schemaVersion: 1,
    plugins: [{ id: 'shadow-production-adapter', version: '1.0.0', auditDefinitions: definitions, auditCases: cases }],
  };
}

function targetRegistry(source) {
  const productionTargetId = source.mode === 'comparative'
    ? source.selectedTargets.find((id) => id.toLowerCase().includes('production')) ?? source.selectedTargets[1]
    : null;
  const singleSiteTargets = source.selectedTargets.map((id) => ({
    id,
    sourceComparativeTargetId: id,
    browserLabel: 'Chromium shadow adapter',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceClass: 'desktop',
    deviceDescriptor: 'Desktop Chrome',
    fidelity: 'browser-engine',
    visual: true,
    fullSweep: true,
  }));
  const localTargets = source.selectedTargets.map((id, index) => {
    const environment = id.toLowerCase().includes('production') || (source.mode === 'comparative' && index > 0)
      ? 'production'
      : 'candidate';
    return {
      id,
      environment,
      ...(source.mode === 'comparative' ? {
        baselineTargetId: environment === 'candidate' ? productionTargetId : null,
      } : {}),
      engine: 'chromium',
      browserProduct: 'chromium',
      deviceClass: 'desktop',
    };
  });
  return {
    schemaVersion: 1,
    defaultTargetIds: [...source.selectedTargets],
    localTargets,
    singleSiteFullProfileTargetIds: [...source.selectedTargets],
    singleSiteTargets,
  };
}

function legacyChecklist(source) {
  const ready = ['RELEASE_READY', 'FEATURE_READY'].includes(source.outcomeCode);
  const failure = source.outcomeCode === 'NOT_READY_TEST_FAILURE';
  const incomplete = source.outcomeCode === 'NOT_READY_INCOMPLETE_EXECUTION';
  return {
    schemaVersion: 1,
    mode: 'comparative',
    release: {
      decision: ready ? 'READY' : 'NOT_READY',
      ready,
      reason: ready ? 'Legacy production checklist passed.' : 'Legacy production checklist did not authorize release.',
      decisionBasis: 'Legacy production checklist validation.',
      blockingFailures: failure ? 1 : 0,
      blockingIncomplete: incomplete ? 1 : 0,
      baselineIssues: source.riskCategories.length,
      runIntegrityFailure: incomplete,
    },
  };
}

function deriveLegacySource(source, observe) {
  let membership = [...source.requiredExecutionIds];
  let definitions = [...source.selectedDefinitions];
  let targets = [...source.selectedTargets];
  if (source.mode === 'single-site') {
    const includeUnselected = source.requestedScope === 'TARGETED';
    const pluginRegistry = fixtureCatalog(source, { includeUnselected });
    const targetsRegistry = targetRegistry(source);
    try {
      const coverage = compileDefinitionCoverageManifest({
        runContract: {
          schemaVersion: 1,
          mode: 'single-site',
          url: CANDIDATE_ORIGIN,
          deploymentRole: 'preview',
          certificatePolicy: 'strict',
          targetIds: [...source.selectedTargets],
          scope: {
            qualifier: source.requestedScope === 'TARGETED' ? 'TARGETED' : 'FULL',
            pluginIds: [],
            auditIds: source.requestedScope === 'TARGETED' ? [...source.selectedDefinitions] : [],
            areas: [],
          },
        },
        pluginRegistry,
        targetRegistry: targetsRegistry,
        preflightBinding: {
          schemaVersion: 1,
          url: CANDIDATE_ORIGIN,
          deploymentRole: 'preview',
          identityFingerprint: `shadow-${source.caseId.toLowerCase()}`,
          deploymentRevision: { status: 'identified', value: `build-${source.caseId.toLowerCase()}` },
          evidenceAuthority: { status: 'authoritative', reasons: [] },
        },
        runnerRevision: 'runner-image:sha256:shadow-fixture',
      });
      receipt(observe, source.caseId, 'legacy', 'compileDefinitionCoverageManifest', coverage.manifestDigest);
      if (coverage.executions.length !== source.requiredExecutionIds.length) {
        throw new Error(`${source.caseId} legacy compiler membership count drifted from the pre-registered matrix.`);
      }
      membership = coverage.executions.map((_, index) => source.requiredExecutionIds[index]);
      definitions = coverage.selectedDefinitions.map(({ auditId }) => auditId);
      targets = coverage.selectedTargets.map(({ targetId }) => targetId);
    } catch (error) {
      if (source.requiredExecutionIds.length !== 0) throw error;
      receipt(observe, source.caseId, 'legacy', 'compileDefinitionCoverageManifest', error.code ?? error.message);
    }
  }

  const parsed = parseChecklistRelease(legacyChecklist(source), `shadow:${source.caseId}:legacy`);
  receipt(observe, source.caseId, 'legacy', 'parseChecklistRelease', parsed.decision);
  return {
    schemaVersion: 1,
    kind: 'legacy-shadow-source',
    caseId: source.caseId,
    mode: source.mode,
    requestedScope: source.requestedScope,
    grantedScope: source.grantedScope,
    selectedFeatures: [...source.selectedFeatures],
    selectedDefinitions: definitions,
    selectedTargets: targets,
    knownLimits: [...source.knownLimits],
    requiredExecutionIds: membership,
    results: structuredClone(source.results),
    riskAvailability: source.riskAvailability,
    riskCategories: [...source.riskCategories],
    outcomeCode: source.outcomeCode,
  };
}

function subjectFor(source, pluginRegistry, targetsRegistry) {
  return sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: `build-${source.caseId.toLowerCase()}` },
    targets: source.mode === 'single-site'
      ? [{ role: 'audited', origin: CANDIDATE_ORIGIN }]
      : [{ role: 'candidate', origin: CANDIDATE_ORIGIN }, { role: 'production', origin: PRODUCTION_ORIGIN }],
    mode: source.mode,
    requestedAuthority: {
      qualifier: source.requestedScope === 'TARGETED' ? 'TARGETED' : 'FULL',
      scope: {
        features: [...source.selectedFeatures],
        definitions: [...source.selectedDefinitions],
        targets: [...source.selectedTargets],
        knownLimits: [...source.knownLimits],
      },
    },
    revisions: {
      runner: DIGEST('1'),
      plugins: canonicalDigest(pluginRegistry),
      targets: canonicalDigest(targetsRegistry),
      configuration: DIGEST('2'),
    },
    environmentIdentity: DIGEST('3'),
    certificatePolicy: 'strict',
  });
}

function compileSharedGraph(source, observe) {
  const pluginRegistry = fixtureCatalog(source);
  const targetsRegistry = targetRegistry(source);
  const subjectCore = subjectFor(source, pluginRegistry, targetsRegistry);
  let inventoryCompletion;
  if (source.mode === 'single-site') {
    const barrier = compileSingleSiteInventoryBarrier({ subjectCore, pluginRegistry, targetRegistry: targetsRegistry });
    inventoryCompletion = completeSingleSiteInventoryBarrier({
      subjectCore,
      barrier,
      attempt: 1,
      routeInventory: {
        schemaVersion: 1,
        origin: CANDIDATE_ORIGIN,
        routes: [{
          url: CANDIDATE_ORIGIN,
          path: '/',
          query: '',
          disposition: 'included',
          sources: [{ source: 'shadow-fixture', from: null, depth: 0 }],
        }],
        limitations: [],
        failures: [],
      },
      deploymentIdentityRecheck: subjectCore.deploymentIdentity,
    });
  }
  const graph = compileCanonicalExecutionGraph({
    subjectCore,
    pluginRegistry,
    targetRegistry: targetsRegistry,
    inventoryCompletion,
    deploymentIdentityRecheck: subjectCore.deploymentIdentity,
  });
  receipt(observe, source.caseId, 'shared', 'compileCanonicalExecutionGraph', graph.digest);
  return graph;
}

function oracleClassification(oracle) {
  if (oracle.outcome === 'completed_pass') return 'COMPLETED_PASS';
  if (oracle.outcome === 'completed_product_failure') return 'COMPLETED_PRODUCT_FAILURE';
  const outcomes = oracle.workItemOutcomes.map(({ outcome }) => outcome);
  if (outcomes.includes('operational_failure')) return 'OPERATIONAL_FAILURE';
  if (outcomes.includes('cancelled')) return 'CANCELLED';
  return 'INCOMPLETE_UNKNOWN';
}

function comparativeFailureSignature(scenario, targetRole) {
  if (scenario === 'MATCHING_SIGNATURES') return BASELINE_FAILURE_SIGNATURE;
  if (scenario !== 'DIFFERING_SIGNATURES') return null;
  if (targetRole === 'candidate') return CANDIDATE_FAILURE_SIGNATURE;
  if (targetRole === 'production') return BASELINE_FAILURE_SIGNATURE;
  throw new Error(`Comparative failure scenario has unsupported target role ${targetRole ?? 'missing'}.`);
}

function projectedRisks(source, graph) {
  if (['EMPTY', 'UNAVAILABLE'].includes(source.riskAvailability)) return [];
  return source.riskCategories.map((category, index) => ({
    schemaVersion: 1,
    category: category.toLowerCase().replaceAll('_', '-'),
    severity: category === 'VISUAL_DEFECT' ? 'critical' : 'high',
    mode: source.mode,
    scope: graph.finalSubject.grantedAuthority.scope,
    source: { kind: 'shadow-production-fixture', id: `${source.caseId.toLowerCase()}-${index + 1}` },
    explanation: `The ${category.toLowerCase().replaceAll('_', ' ')} condition remains visible in shadow validation.`,
    recommendedAction: 'Review the production-derived shadow comparison before cutover.',
    reviewState: category === 'UNREVIEWED_VISUAL_CHANGE' ? 'PENDING_REVIEW' : 'OPEN',
    releaseEffect: 'non-blocking',
    actor: { id: 'shadow-validator', kind: 'service' },
    observedAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  }));
}

function projectedSharedSource(source, graph, observe) {
  const requestedResults = new Map(source.results.map((result) => [result.executionId, result.classification]));
  if (graph.oraclePlans.length !== source.requiredExecutionIds.length) {
    throw new Error(`${source.caseId} shared compiler membership count drifted from the pre-registered matrix.`);
  }
  const oracleResults = graph.oraclePlans.map((oraclePlan, index) => {
    const semanticId = source.requiredExecutionIds[index];
    const classification = requestedResults.get(semanticId) ?? 'INCOMPLETE_UNKNOWN';
    const comparativeScenario = SHADOW_COMPARATIVE_FAILURE_SCENARIOS[source.caseId] ?? null;
    const oracleExecution = graph.executionManifest.oracleExecutions.find(({ id }) => id === oraclePlan.id);
    const bindings = new Map(oracleExecution.workItemBindings.map((binding) => [binding.workItemId, binding]));
    const workItemResults = oraclePlan.requiredWorkItemIds.map((workItemId, workIndex) => {
      const targetRole = bindings.get(workItemId)?.targetRole;
      const productFailureSignature = comparativeFailureSignature(comparativeScenario, targetRole);
      const outcome = productFailureSignature === null
        ? workIndex === 0 ? RESULT_TO_WORK_OUTCOME[classification] : 'completed_pass'
        : 'completed_product_failure';
      return sealWorkItemResult({
        schemaVersion: 1,
        workItemId,
        subjectCoreDigest: graph.subjectCoreDigest,
        attempt: 1,
        authoritative: true,
        outcome,
        evidenceDigests: [DIGEST('4')],
        ...(productFailureSignature === null ? {} : { productFailureSignature }),
      });
    });
    const oracle = sealOracleResult({
      schemaVersion: 1,
      oracleExecution,
      finalSubjectDigest: graph.finalSubject.digest,
      workItemResults,
    });
    if (oracle.comparisonResults.length > 0) {
      receipt(observe, source.caseId, 'shared', 'sealOracleResult', oracle.comparisonResults.map((comparison) => ({
        classification: comparison.classification,
        candidateProductFailureSignatureDigest: comparison.candidateProductFailureSignatureDigest,
        productionProductFailureSignatureDigest: comparison.productionProductFailureSignatureDigest,
      })));
    }
    return oracle;
  });
  const view = projectSharedReleaseView({
    schemaVersion: 1,
    runId: `shadow-${source.caseId.toLowerCase()}`,
    baseDecisionRevision: 1,
    baseRiskRevision: 1,
    finalSubject: graph.finalSubject,
    executionManifest: graph.executionManifest,
    oracleResults,
    riskAvailability: source.riskAvailability,
    riskSources: projectedRisks(source, graph),
    riskLifecycleEvents: [],
    visualDispositions: [],
  });
  receipt(observe, source.caseId, 'shared', 'projectSharedReleaseView', view.decision.digest);
  return { view, oracleResults };
}

function expectRejection(caseId, invoke, observe) {
  try {
    invoke();
  } catch (error) {
    receipt(observe, caseId, 'shared', 'production-rejection-validator', error?.code ?? error?.message ?? 'unknown');
    return error;
  }
  throw new Error(`${caseId} production rejection probe unexpectedly succeeded.`);
}

async function probeStaleQueueFence(caseId, observe) {
  const root = await mkdtemp(join(tmpdir(), 'shadow-stale-fence-'));
  try {
    let nonceSequence = 0;
    const queue = await openJobQueue({
      root,
      clock: () => Date.parse(FIXTURE_TIMESTAMP),
      nonce: () => `shadow-${++nonceSequence}`,
      heartbeatMs: 100,
      leaseMs: 500,
      lockStaleMs: 1_000,
    });
    const digest = (label) => sha256(`shadow-stale-fence:${label}`);
    const submitted = await submitJob(queue, {
      idempotencyKey: 'shadow-stale-fence',
      runMode: 'single-site',
      inputDocumentDigest: digest('input'),
      runContractDigest: digest('contract'),
      compiledManifestDigest: digest('manifest'),
      preflightDigest: digest('preflight'),
      identityFingerprint: digest('identity'),
      revisionFingerprint: digest('revision'),
      evidenceAuthority: { authoritative: true, reasons: [] },
      registryRevision: 'shadow-registry-v1',
      targetSetRevision: 'shadow-targets-v1',
      runnerRevision: 'shadow-runner-v1',
      stageDeadlines: {
        browser: '2030-01-01T00:10:00.000Z',
        finalizer: '2030-01-01T00:20:00.000Z',
      },
    });
    const staleClaim = await claimJob(queue, submitted.state.jobId, 'shadow-worker');
    await cancelJob(queue, submitted.state.jobId, 'Fence the shadow fixture attempt.');
    try {
      await publishAttemptDocument(queue, staleClaim, {
        publicationId: 'stale-shadow-result',
        relativePath: 'results/stale.json',
        document: { stale: true },
      });
    } catch (error) {
      if (error?.code !== 'QUEUE_STALE_FENCE') throw error;
      receipt(observe, caseId, 'shared', 'production-rejection-validator', error.code);
      return error;
    }
    throw new Error(`${caseId} production queue accepted a stale fencing token.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function probeRejectedSource(source, graph, projection, observe) {
  const decisionInput = {
    schemaVersion: 1,
    runId: `shadow-${source.caseId.toLowerCase()}`,
    decisionRevision: 1,
    finalSubject: graph?.finalSubject,
    executionManifest: graph?.executionManifest,
    oracleResults: projection?.oracleResults ?? [],
    releaseDispositions: [],
  };
  const firstExecutionId = graph?.executionManifest.oracleExecutions[0]?.id;
  switch (source.caseId) {
    case 'AE11':
    case 'CR06_WRONG_SUBJECT':
      return expectRejection(source.caseId, () => assertConsumableReleaseDecision(projection.view.decision, {
        expectedSubjectDigest: DIGEST('9'),
        expectedAuthority: projection.view.decision.grantedAuthority,
        currentDecisionRevision: projection.view.decision.decisionRevision,
      }), observe);
    case 'AE13':
      return expectRejection(source.caseId, () => deriveReleaseDecision({
        ...decisionInput,
        releaseDispositions: [{
          kind: 'visual-defect', executionId: firstExecutionId, reason: 'Unauthorized shadow mutation.',
          authorized: false, actor: { id: 'viewer', kind: 'operator' },
        }],
      }), observe);
    case 'CR02_DUPLICATE_ACCEPTED_RESULT':
      return expectRejection(source.caseId, () => deriveReleaseDecision({
        ...decisionInput,
        oracleResults: [projection.oracleResults[0], projection.oracleResults[0]],
      }), observe);
    case 'CR03_UNDECLARED_RESULT': {
      const undeclared = { ...projection.oracleResults[0], oracleExecutionId: 'undeclared-oracle' };
      return expectRejection(source.caseId, () => deriveReleaseDecision({
        ...decisionInput,
        oracleResults: [undeclared],
      }), observe);
    }
    case 'CR04_CROSS_BATCH_RESULT': {
      const crossed = structuredClone(graph.executionManifest);
      crossed.oracleExecutions[0].requiredWorkItemIds = ['work-from-another-batch'];
      const { digest: _discardedDigest, ...crossedBody } = crossed;
      crossed.digest = canonicalDigest(crossedBody);
      return expectRejection(source.caseId, () => parseExecutionManifest(crossed), observe);
    }
    case 'CR05_STALE_FENCE': {
      return probeStaleQueueFence(source.caseId, observe);
    }
    case 'CR07_WRONG_RUN': {
      const history = appendVisualDisposition([], {
        schemaVersion: 1,
        expectedReviewRevision: 0,
        runId: 'correct-run',
        mode: source.mode,
        subjectDigest: graph.finalSubject.digest,
        executionId: firstExecutionId,
        riskIdentity: DIGEST('7'),
        disposition: 'ACCEPTED',
        actor: { id: 'reviewer', kind: 'operator' },
        rationale: 'The first disposition establishes one immutable run binding.',
        at: FIXTURE_TIMESTAMP,
      });
      return expectRejection(source.caseId, () => appendVisualDisposition(history, {
        schemaVersion: 1,
        expectedReviewRevision: 1,
        runId: 'wrong-run',
        mode: source.mode,
        subjectDigest: graph.finalSubject.digest,
        executionId: firstExecutionId,
        riskIdentity: DIGEST('7'),
        disposition: 'ACCEPTED',
        actor: { id: 'reviewer', kind: 'operator' },
        rationale: 'A disposition from another run must fail closed.',
        at: FIXTURE_TIMESTAMP,
      }), observe);
    }
    case 'CR08_DIGEST_BREAK': {
      const corrupt = { ...graph.executionManifest, digest: DIGEST('6') };
      return expectRejection(source.caseId, () => parseExecutionManifest(corrupt), observe);
    }
    case 'CR13_STALE_REVISION':
    case 'CR16_RESTORED_STALE_SNAPSHOT':
      return expectRejection(source.caseId, () => assertConsumableReleaseDecision(projection.view.decision, {
        expectedSubjectDigest: projection.view.decision.subjectDigest,
        expectedAuthority: projection.view.decision.grantedAuthority,
        currentDecisionRevision: projection.view.decision.decisionRevision + 1,
      }), observe);
    case 'CR14_LEGACY_READY_ONLY':
      return expectRejection(source.caseId, () => parseReleaseDecision(legacyChecklist({ ...source, outcomeCode: 'RELEASE_READY' })), observe);
    case 'CR15_SHADOW_CONSUMPTION':
      return expectRejection(source.caseId, () => parsePublicationEnvelope(source), observe);
    default:
      throw new Error(`No production rejection probe is registered for ${source.caseId}.`);
  }
}

async function deriveSharedSource(source, observe) {
  let graph;
  try {
    graph = compileSharedGraph(source, observe);
  } catch (error) {
    if (source.requiredExecutionIds.length !== 0 || source.outcomeCode !== 'REJECTED_SCOPE_MISMATCH') throw error;
    receipt(observe, source.caseId, 'shared', 'production-rejection-validator', error.code ?? error.message);
    return structuredClone(source);
  }
  const projection = projectedSharedSource(source, graph, observe);
  if (source.caseId === 'CR10_REKICK_RECOVERY') {
    const rekick = compileIncompleteWorkRekick({ graph, incompleteWorkItemIds: [graph.workItemPlans[0].id] });
    if (rekick.executionManifestDigest !== graph.executionManifest.digest) {
      throw new Error('Incomplete-only rekick changed canonical execution membership.');
    }
    receipt(observe, source.caseId, 'shared', 'compileIncompleteWorkRekick', rekick.digest);
  }
  if (source.outcomeCode.startsWith('REJECTED_')) await probeRejectedSource(source, graph, projection, observe);

  const actualCategories = projection.view.riskRegister.risks
    .map(({ category }) => category.toUpperCase().replaceAll('-', '_'));
  const rejected = source.outcomeCode.startsWith('REJECTED_');
  return {
    schemaVersion: 1,
    kind: 'shared-shadow-source',
    caseId: source.caseId,
    mode: graph.mode,
    requestedScope: graph.finalSubject.grantedAuthority.qualifier,
    grantedScope: rejected ? 'NONE' : projection.view.decision.grantedAuthority,
    selectedFeatures: [...graph.finalSubject.grantedAuthority.scope.features],
    selectedDefinitions: [...graph.coverageBasis.selectedDefinitions],
    selectedTargets: [...graph.coverageBasis.selectedTargets],
    knownLimits: [...graph.finalSubject.grantedAuthority.scope.knownLimits],
    requiredExecutionIds: graph.oraclePlans.map((_, index) => source.requiredExecutionIds[index]),
    results: projection.oracleResults.flatMap((oracle, index) => {
      const executionId = source.requiredExecutionIds[index];
      return source.results.some((result) => result.executionId === executionId)
        ? [{ executionId, classification: oracleClassification(oracle) }]
        : [];
    }),
    riskAvailability: projection.view.riskRegister.availability,
    riskCategories: actualCategories,
    outcomeCode: rejected ? source.outcomeCode : projection.view.decision.code,
  };
}

export async function buildProductionDerivedShadowMatrix({ observe } = {}) {
  if (observe !== undefined && typeof observe !== 'function') {
    throw new TypeError('Shadow adapter observe hook must be a function.');
  }
  const registered = buildPreRegisteredShadowMatrix();
  const cases = [];
  for (const entry of registered.cases) {
    cases.push({
      caseId: entry.caseId,
      title: entry.title,
      governingRequirements: [...entry.governingRequirements],
      legacy: deriveLegacySource(entry.legacy, observe),
      shared: await deriveSharedSource(entry.shared, observe),
    });
  }
  return {
    cases,
    intentionalDifferences: structuredClone(registered.intentionalDifferences),
  };
}
