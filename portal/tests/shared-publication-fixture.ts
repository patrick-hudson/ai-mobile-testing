import { sealExecutionManifest, sealOracleResult, sealWorkItemResult } from '../../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../../shared/publication-envelope.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../../shared/release-subject.mjs';
import { projectPublicationView, projectSharedReleaseView } from '../../shared/release-projection.mjs';
import { parseRisk } from '../../shared/risk-contract.mjs';

export type SharedMode = 'comparative' | 'single-site';
export type RiskAvailability = 'LOADING' | 'PROVISIONAL' | 'AVAILABLE' | 'PARTIAL' | 'EMPTY' | 'UNAVAILABLE';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

export function sharedPublicationFixture(
  mode: SharedMode,
  runId: string,
  availability: RiskAvailability = 'PARTIAL',
  runRevision = 7,
  riskCount = 2,
) {
  const targets = mode === 'single-site'
    ? [{ role: 'audited', origin: 'https://beta.example.test' }]
    : [{ role: 'candidate', origin: 'https://beta.example.test' }, { role: 'production', origin: 'https://example.test' }];
  const targetIds = mode === 'single-site' ? ['preview-desktop'] : ['candidate-desktop', 'production-desktop'];
  const core = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: `build-${mode}` },
    targets,
    mode,
    requestedAuthority: {
      qualifier: 'TARGETED',
      scope: {
        features: ['navigation'],
        definitions: ['NAV-001'],
        targets: targetIds,
        knownLimits: mode === 'single-site'
          ? ['Comparison-only checkout parity is not applicable in Single-site mode.']
          : [],
      },
    },
    revisions: { runner: D1, plugins: D1, targets: D1, configuration: D1 },
    environmentIdentity: D2,
    certificatePolicy: mode === 'single-site' ? 'preview-bypass' : 'strict',
  });
  const workItems = targetIds.map((targetId, index) => ({
    id: `work-${index + 1}`,
    definitionId: 'NAV-001',
    targetId,
    targetRole: mode === 'single-site' ? 'audited' : index === 0 ? 'candidate' : 'production',
  }));
  const manifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: core.digest,
    workItems,
    oracleExecutions: [{ id: 'oracle-navigation', definitionId: 'NAV-001', requiredWorkItemIds: workItems.map(({ id }) => id) }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore: core,
    executionManifest: manifest,
    grantedAuthority: core.requestedAuthority,
    coverageBasis: {
      selectedDefinitions: ['NAV-001'],
      selectedTargets: targetIds,
      excludedAsNotApplicable: mode === 'single-site' ? ['COMPARE-ONLY-001'] : [],
    },
    deploymentIdentityRecheck: core.deploymentIdentity,
  });
  const results = workItems.map(({ id }) => sealWorkItemResult({
    schemaVersion: 1,
    workItemId: id,
    subjectCoreDigest: core.digest,
    attempt: 1,
    authoritative: true,
    outcome: 'completed_pass',
    evidenceDigests: [D1],
  }));
  const oracle = sealOracleResult({
    schemaVersion: 1,
    oracleExecution: manifest.oracleExecutions[0],
    finalSubjectDigest: finalSubject.digest,
    workItemResults: results,
  });
  const baseRiskSources = [
    {
      schemaVersion: 1,
      category: 'manual-check',
      severity: 'high',
      mode,
      scope: finalSubject.grantedAuthority.scope,
      source: { kind: 'manual-obligation', id: 'physical-device-review' },
      explanation: 'Manual checkout remains outstanding.',
      recommendedAction: 'Review checkout on a physical device.',
      reviewState: 'OPEN',
      releaseEffect: 'non-blocking',
      actor: { id: 'runner', kind: 'service' },
      observedAt: '2026-08-29T14:00:00.000Z',
      updatedAt: '2026-08-29T14:00:00.000Z',
    },
    {
      schemaVersion: 1,
      category: 'certificate-bypass',
      severity: 'medium',
      mode,
      scope: finalSubject.grantedAuthority.scope,
      source: { kind: 'configuration', id: 'tls-policy' },
      explanation: 'Certificate validation bypass is enabled for this development target.',
      recommendedAction: 'Restore certificate validation before production use.',
      reviewState: 'OPEN',
      releaseEffect: 'non-blocking',
      actor: { id: 'runner', kind: 'service' },
      observedAt: '2026-08-29T14:00:00.000Z',
      updatedAt: '2026-08-29T14:00:00.000Z',
    },
  ];
  const riskSources = ['LOADING', 'UNAVAILABLE', 'EMPTY'].includes(availability) ? [] : Array.from(
    { length: riskCount },
    (_, index) => parseRisk(index < baseRiskSources.length ? baseRiskSources[index] : {
      ...baseRiskSources[index % baseRiskSources.length],
      severity: (['low', 'critical', 'medium', 'high'] as const)[index % 4],
      reviewState: (['RESOLVED', 'SUPERSEDED', 'OPEN', 'ACKNOWLEDGED'] as const)[index % 4],
      source: { kind: 'generated-risk-fixture', id: `risk-${String(index + 1).padStart(4, '0')}` },
      explanation: `Generated archive risk ${index + 1}.`,
      recommendedAction: `Review generated archive risk ${index + 1}.`,
    }),
  );
  const projected = projectSharedReleaseView({
    schemaVersion: 1,
    runId,
    baseDecisionRevision: 3,
    baseRiskRevision: 2,
    finalSubject,
    executionManifest: manifest,
    oracleResults: [oracle],
    riskAvailability: availability,
    riskSources,
    riskLifecycleEvents: [],
    visualDispositions: [],
  });
  const envelope = appendPublicationEnvelope(null, {
    schemaVersion: 1,
    runId,
    runRevision,
    decisionRevision: projected.decisionRevision,
    riskRevision: projected.riskRevision,
    ledgerSequences: { observations: 1, decisions: projected.decisionRevision, risks: projected.riskRevision },
    finalSubjectDigest: finalSubject.digest,
    decision: projected.decision,
    riskRegister: projected.riskRegister,
  });
  return { envelope, view: projectPublicationView(envelope) };
}
