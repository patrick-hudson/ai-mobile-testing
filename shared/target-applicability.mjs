export function targetMatchesAuditApplicability(applicability, target) {
  const candidate = target.environment === 'candidate';
  const production = target.environment === 'production';
  const mobile = target.deviceClass === 'mobile';
  const desktop = target.deviceClass === 'desktop';
  const chromium = target.engine === 'chromium' || String(target.id).includes('chromium');
  switch (applicability) {
    case 'all-projects': return true;
    case 'full-sweep-projects': return target.fullSweep === true;
    case 'candidate-full-sweep-projects': return candidate && target.fullSweep === true;
    case 'candidate-projects': return candidate;
    case 'production-projects': return production;
    case 'candidate-non-tablet-projects': return candidate && target.deviceClass !== 'tablet';
    case 'candidate-chromium-projects': return candidate && chromium;
    case 'production-chromium-projects': return production && chromium;
    case 'candidate-desktop-projects': return candidate && desktop;
    // These two historical applicability values name the original canonical
    // projects, but intentionally describe the whole matching form factor so
    // Android emulations and Edge-compatible Chromium opt-ins execute too.
    case 'candidate-desktop-chromium': return candidate && chromium && desktop;
    case 'candidate-mobile-projects': return candidate && mobile;
    case 'candidate-mobile-chromium': return candidate && chromium && mobile;
    default: return target.id === applicability;
  }
}

export function applicableTargetIds(applicability, targets) {
  return targets
    .filter((target) => targetMatchesAuditApplicability(applicability, target))
    .map(({ id }) => id);
}

export function singleSiteTargetMatchesAuditApplicability(applicability, target, comparativeTargets) {
  if (!target || typeof target.sourceComparativeTargetId !== 'string' || 'environment' in target) {
    throw new Error('Single-site applicability requires a neutral target with comparative template provenance.');
  }
  const source = comparativeTargets.find(({ id }) => id === target.sourceComparativeTargetId);
  if (!source || source.environment !== 'candidate') {
    throw new Error(`Single-site target ${target.id ?? '<unknown>'} references an invalid candidate applicability template.`);
  }
  return targetMatchesAuditApplicability(applicability, source);
}

export function applicableSingleSiteTargetIds(applicability, targets, comparativeTargets) {
  return targets
    .filter((target) => singleSiteTargetMatchesAuditApplicability(applicability, target, comparativeTargets))
    .map(({ id }) => id);
}
