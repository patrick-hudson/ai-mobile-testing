const CANONICAL_EXECUTION_MODE = 'external-sharded-performance-isolated';

export function releaseReviewReasons(manifest, fullProjectCount) {
  const reasons = [];
  if (manifest.options?.candidateIgnoreHTTPSErrors) {
    reasons.push('candidate certificate verification was bypassed');
  }
  if ((manifest.progress?.flaky ?? 0) > 0) {
    reasons.push(`${manifest.progress.flaky} flaky browser check${manifest.progress.flaky === 1 ? '' : 's'} must be reviewed`);
  }
  const auditIds = Array.isArray(manifest.options?.auditIds) ? manifest.options.auditIds : [];
  const projects = Array.isArray(manifest.options?.projects) ? manifest.options.projects : [];
  if (manifest.options?.profile !== 'release') {
    reasons.push('a smoke run cannot certify release readiness');
  } else if (auditIds.length > 0 || projects.length !== fullProjectCount) {
    reasons.push('the selected scope is not a complete release matrix and cannot certify release readiness');
  }
  if (manifest.executionProvenance?.mode !== CANONICAL_EXECUTION_MODE
    || manifest.executionProvenance?.sharded !== true
    || manifest.executionProvenance?.performanceIsolated !== true) {
    reasons.push('this portal-launched single-container run is review evidence only; final signoff requires a new-ID sharded release run with isolated performance provenance');
  }
  return reasons;
}

export function applyCompletedReleaseEligibility(manifest, release, context, fullProjectCount) {
  const reviewReasons = releaseReviewReasons(manifest, fullProjectCount);
  const finishedAt = new Date().toISOString();
  manifest.reviewReasons = reviewReasons;
  manifest.pipeline = {
    status: 'completed',
    completed: true,
    reason: context,
    finishedAt,
  };
  manifest.release = release;
  manifest.status = release.decision === 'NOT_READY'
    ? 'not-ready'
    : reviewReasons.length > 0
      ? 'review-required'
      : 'passed';

  const checklistDecision = release.decision.replace('_', ' ');
  manifest.phase = release.decision === 'NOT_READY'
    ? `${context} · release NOT READY${reviewReasons.length > 0 ? ` · additional review requirements: ${reviewReasons.join('; ')}` : ''}`
    : reviewReasons.length > 0
      ? `${context} · checklist READY · release signoff withheld: ${reviewReasons.join('; ')}`
      : `${context} · release READY`;
  return manifest;
}

export function canonicalExecutionProvenance() {
  return {
    mode: CANONICAL_EXECUTION_MODE,
    sharded: true,
    performanceIsolated: true,
    authority: 'release-signoff-eligible',
  };
}

export function portalExecutionProvenance() {
  return {
    mode: 'portal-single-container',
    sharded: false,
    performanceIsolated: false,
    authority: 'review-evidence-only',
    finalSignoffCommand: 'npm run audit:release:sharded',
    newRunIdRequired: true,
  };
}
