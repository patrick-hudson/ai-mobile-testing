import { createHash } from 'node:crypto';

export const DEFINITION_COVERAGE_MANIFEST_SCHEMA_VERSION = 1;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => !nonEmptyString(value))) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  const normalized = values.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates.`);
  return normalized;
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`Canonical JSON does not support undefined at ${key}.`);
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function validateSingleSiteContract(contract) {
  if (!isRecord(contract) || contract.schemaVersion !== 1 || contract.mode !== 'single-site') {
    throw new Error('Definition coverage compilation requires a parsed schemaVersion 1 Single-site run contract.');
  }
  if (!nonEmptyString(contract.url) || !['preview', 'production'].includes(contract.deploymentRole)) {
    throw new Error('Single-site run contract must retain its normalized URL and confirmed Deployment Role.');
  }
  const targetIds = uniqueStrings(contract.targetIds, 'runContract.targetIds');
  if (!isRecord(contract.scope) || !['FULL', 'TARGETED'].includes(contract.scope.qualifier)) {
    throw new Error('Single-site run contract must contain a FULL or TARGETED scope.');
  }
  return {
    ...contract,
    targetIds,
    scope: {
      qualifier: contract.scope.qualifier,
      pluginIds: uniqueStrings(contract.scope.pluginIds, 'runContract.scope.pluginIds'),
      auditIds: uniqueStrings(contract.scope.auditIds, 'runContract.scope.auditIds'),
      areas: uniqueStrings(contract.scope.areas, 'runContract.scope.areas'),
    },
  };
}

function validatePreflightBinding(binding, contract) {
  if (!isRecord(binding) || binding.schemaVersion !== 1) {
    throw new Error('preflightBinding must use schemaVersion 1.');
  }
  if (binding.url !== contract.url || binding.deploymentRole !== contract.deploymentRole) {
    throw new Error('Preflight binding URL and Deployment Role must match the parsed run contract exactly.');
  }
  if (!nonEmptyString(binding.identityFingerprint)) {
    throw new Error('preflightBinding.identityFingerprint must be a non-empty string.');
  }
  if (!isRecord(binding.deploymentRevision)
    || !['identified', 'unavailable'].includes(binding.deploymentRevision.status)
    || (binding.deploymentRevision.status === 'identified' && !nonEmptyString(binding.deploymentRevision.value))
    || (binding.deploymentRevision.status === 'unavailable' && binding.deploymentRevision.value !== null)) {
    throw new Error('preflightBinding.deploymentRevision must explicitly identify a revision or record that it is unavailable.');
  }
  if (!isRecord(binding.evidenceAuthority)
    || !['authoritative', 'non-authoritative'].includes(binding.evidenceAuthority.status)) {
    throw new Error('preflightBinding.evidenceAuthority must be authoritative or non-authoritative.');
  }
  const reasons = uniqueStrings(binding.evidenceAuthority.reasons, 'preflightBinding.evidenceAuthority.reasons');
  const knownAuthorityReasons = new Set(['development-certificate-bypass', 'deployment-revision-unavailable']);
  if (reasons.some((reason) => !knownAuthorityReasons.has(reason))) {
    throw new Error('preflightBinding.evidenceAuthority contains an unknown limitation reason.');
  }
  if (binding.evidenceAuthority.status === 'authoritative' && reasons.length > 0) {
    throw new Error('Authoritative preflight evidence must not contain authority limitations.');
  }
  if (binding.evidenceAuthority.status === 'non-authoritative' && reasons.length === 0) {
    throw new Error('Non-authoritative preflight evidence must explain at least one limitation.');
  }
  return {
    schemaVersion: 1,
    url: binding.url,
    deploymentRole: binding.deploymentRole,
    identityFingerprint: binding.identityFingerprint,
    deploymentRevision: {
      status: binding.deploymentRevision.status,
      value: binding.deploymentRevision.value,
    },
    evidenceAuthority: {
      status: binding.evidenceAuthority.status,
      reasons: sortedStrings(reasons),
    },
  };
}

function validateTargetRegistry(registry) {
  if (!isRecord(registry) || registry.schemaVersion !== 1
    || !Array.isArray(registry.singleSiteTargets)
    || !Array.isArray(registry.singleSiteFullProfileTargetIds)) {
    throw new Error('Target registry must expose schemaVersion 1 Single-site targets and a full profile.');
  }
  const fullProfileTargetIds = uniqueStrings(
    registry.singleSiteFullProfileTargetIds,
    'targetRegistry.singleSiteFullProfileTargetIds',
  );
  const targetIds = new Set();
  const targets = registry.singleSiteTargets.map((target, index) => {
    if (!isRecord(target) || !nonEmptyString(target.id) || !nonEmptyString(target.sourceComparativeTargetId)) {
      throw new Error(`targetRegistry.singleSiteTargets[${index}] is invalid.`);
    }
    if (targetIds.has(target.id)) throw new Error(`Duplicate Single-site target ID: ${target.id}.`);
    targetIds.add(target.id);
    return target;
  });
  const unknownFullTargets = fullProfileTargetIds.filter((id) => !targetIds.has(id));
  if (unknownFullTargets.length > 0) {
    throw new Error(`Single-site full profile references unknown targets: ${unknownFullTargets.join(', ')}.`);
  }
  return { targets, fullProfileTargetIds };
}

function validatePluginRegistry(registry) {
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) {
    throw new Error('Plugin registry must use schemaVersion 1 and contain plugins.');
  }
  const pluginIds = new Set();
  const definitionIds = new Set();
  const caseIds = new Set();
  const plugins = registry.plugins.map((plugin, pluginIndex) => {
    if (!isRecord(plugin) || !nonEmptyString(plugin.id)
      || !Array.isArray(plugin.auditDefinitions) || !Array.isArray(plugin.auditCases)) {
      throw new Error(`pluginRegistry.plugins[${pluginIndex}] is invalid.`);
    }
    if (pluginIds.has(plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}.`);
    pluginIds.add(plugin.id);
    const definitions = plugin.auditDefinitions.map((definition, definitionIndex) => {
      if (!isRecord(definition) || !nonEmptyString(definition.id)
        || !nonEmptyString(definition.area) || !nonEmptyString(definition.title)
        || !['standalone-compatible', 'comparison-only', 'standalone-required'].includes(definition.singleSiteClassification)) {
        throw new Error(`${plugin.id}.auditDefinitions[${definitionIndex}] lacks Single-site classification metadata.`);
      }
      if (definitionIds.has(definition.id)) throw new Error(`Duplicate Audit Definition ID: ${definition.id}.`);
      definitionIds.add(definition.id);
      return definition;
    });
    const ownedDefinitions = new Map(definitions.map((definition) => [definition.id, definition]));
    const cases = plugin.auditCases.map((auditCase, caseIndex) => {
      if (!isRecord(auditCase) || !nonEmptyString(auditCase.caseId)
        || !nonEmptyString(auditCase.auditId) || !ownedDefinitions.has(auditCase.auditId)
        || !nonEmptyString(auditCase.entrySpec) || !nonEmptyString(auditCase.applicability)
        || !Array.isArray(auditCase.supportedModes) || !isRecord(auditCase.oracleVariants)) {
        throw new Error(`${plugin.id}.auditCases[${caseIndex}] lacks executable-case metadata.`);
      }
      if (caseIds.has(auditCase.caseId)) throw new Error(`Duplicate executable case ID: ${auditCase.caseId}.`);
      caseIds.add(auditCase.caseId);
      const supportedModes = uniqueStrings(auditCase.supportedModes, `${auditCase.caseId}.supportedModes`);
      if (supportedModes.some((mode) => mode !== 'comparative' && mode !== 'single-site')) {
        throw new Error(`${auditCase.caseId}.supportedModes contains an unknown mode.`);
      }
      const supportsSingleSite = supportedModes.includes('single-site');
      const supportsComparative = supportedModes.includes('comparative');
      if (supportsComparative !== nonEmptyString(auditCase.oracleVariants.comparative)) {
        throw new Error(`${auditCase.caseId} must bind its comparative mode to one named Product Oracle variant.`);
      }
      if (supportsSingleSite !== nonEmptyString(auditCase.oracleVariants.singleSite)) {
        throw new Error(`${auditCase.caseId} must bind its Single-site mode to one named Product Oracle variant.`);
      }
      if (supportsSingleSite && ownedDefinitions.get(auditCase.auditId).singleSiteClassification === 'comparison-only') {
        throw new Error(`${auditCase.caseId} cannot make a comparison-only definition executable in Single-site mode.`);
      }
      if (!Array.isArray(auditCase.supportedProjects)
        || auditCase.supportedProjects.some((project) => !nonEmptyString(project))) {
        throw new Error(`${auditCase.caseId}.supportedProjects is invalid.`);
      }
      return { ...auditCase, supportedModes };
    });
    return { ...plugin, auditDefinitions: definitions, auditCases: cases };
  });
  return plugins;
}

function selectedByScope(definition, pluginId, scope) {
  const hasFilters = scope.pluginIds.length > 0 || scope.auditIds.length > 0 || scope.areas.length > 0;
  return !hasFilters
    || scope.pluginIds.includes(pluginId)
    || scope.auditIds.includes(definition.id)
    || scope.areas.includes(definition.area);
}

function definitionSummary(pluginId, definition) {
  return {
    pluginId,
    auditId: definition.id,
    area: definition.area,
    title: definition.title,
    severity: definition.severity,
    manual: definition.manual === true,
    singleSiteClassification: definition.singleSiteClassification,
    ...(isRecord(definition.standaloneOracle)
      ? { standaloneOracle: { id: definition.standaloneOracle.id, expected: definition.standaloneOracle.expected } }
      : {}),
  };
}

function targetSummary(target) {
  return {
    targetId: target.id,
    sourceComparativeTargetId: target.sourceComparativeTargetId,
    browserLabel: target.browserLabel,
    deviceClass: target.deviceClass,
    engine: target.engine,
    browserProduct: target.browserProduct,
    deviceDescriptor: target.deviceDescriptor,
    fidelity: target.fidelity,
    visual: target.visual,
    fullSweep: target.fullSweep,
  };
}

function validateRequestedFilters(scope, plugins) {
  const knownPlugins = new Set(plugins.map(({ id }) => id));
  const knownDefinitions = new Set(plugins.flatMap(({ auditDefinitions }) => auditDefinitions.map(({ id }) => id)));
  const knownAreas = new Set(plugins.flatMap(({ auditDefinitions }) => auditDefinitions.map(({ area }) => area)));
  const unknownPlugins = scope.pluginIds.filter((id) => !knownPlugins.has(id));
  const unknownDefinitions = scope.auditIds.filter((id) => !knownDefinitions.has(id));
  const unknownAreas = scope.areas.filter((area) => !knownAreas.has(area));
  if (unknownPlugins.length || unknownDefinitions.length || unknownAreas.length) {
    throw new Error([
      unknownPlugins.length ? `unknown plugins: ${unknownPlugins.join(', ')}` : '',
      unknownDefinitions.length ? `unknown audits: ${unknownDefinitions.join(', ')}` : '',
      unknownAreas.length ? `unknown areas: ${unknownAreas.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

export function compileDefinitionCoverageManifest({
  runContract,
  pluginRegistry,
  targetRegistry,
  preflightBinding,
  runnerRevision,
}) {
  const contract = validateSingleSiteContract(runContract);
  if (!nonEmptyString(runnerRevision)) throw new Error('runnerRevision must be a non-empty immutable revision.');
  const preflight = validatePreflightBinding(preflightBinding, contract);
  const plugins = validatePluginRegistry(pluginRegistry);
  const { targets, fullProfileTargetIds } = validateTargetRegistry(targetRegistry);
  validateRequestedFilters(contract.scope, plugins);

  const targetById = new Map(targets.map((target) => [target.id, target]));
  const unknownSelectedTargets = contract.targetIds.filter((id) => !targetById.has(id));
  if (unknownSelectedTargets.length > 0) {
    throw new Error(`Run contract selects unknown Single-site targets: ${unknownSelectedTargets.join(', ')}.`);
  }
  const selectedTargets = contract.targetIds.map((id) => targetById.get(id));
  const requiredTargetsSelected = fullProfileTargetIds.every((id) => contract.targetIds.includes(id));
  const omittedTargets = targets
    .filter(({ id }) => !contract.targetIds.includes(id))
    .map((target) => ({
      ...targetSummary(target),
      disposition: fullProfileTargetIds.includes(target.id) ? 'operator-omitted-required-target' : 'optional-target-not-selected',
    }))
    .sort((left, right) => left.targetId.localeCompare(right.targetId));

  const selectedDefinitions = [];
  const omittedDefinitions = [];
  const outsideMode = [];
  const coverageGaps = [];
  const executions = [];
  const selectedCaseIds = new Set();
  const omittedCases = [];
  const requestedComparisonOnly = [];

  for (const plugin of [...plugins].sort((left, right) => left.id.localeCompare(right.id))) {
    const casesByAudit = new Map();
    for (const auditCase of plugin.auditCases) {
      const cases = casesByAudit.get(auditCase.auditId) ?? [];
      cases.push(auditCase);
      casesByAudit.set(auditCase.auditId, cases);
    }
    for (const definition of [...plugin.auditDefinitions].sort((left, right) => left.id.localeCompare(right.id))) {
      const summary = definitionSummary(plugin.id, definition);
      const allCases = casesByAudit.get(definition.id) ?? [];
      const singleSiteCases = allCases.filter(({ supportedModes }) => supportedModes.includes('single-site'));
      const comparativeCases = allCases.filter(({ supportedModes }) => supportedModes.includes('comparative'));

      if (definition.singleSiteClassification === 'comparison-only') {
        if (selectedByScope(definition, plugin.id, contract.scope)) requestedComparisonOnly.push(definition.id);
        outsideMode.push({
          ...summary,
          disposition: 'outside-single-site-mode',
          comparativeCaseIds: sortedStrings(comparativeCases.map(({ caseId }) => caseId)),
        });
        continue;
      }
      if (!selectedByScope(definition, plugin.id, contract.scope)) {
        omittedDefinitions.push({ ...summary, disposition: 'operator-scope-omission' });
        continue;
      }

      const executionIds = [];
      const includedCaseIds = [];
      for (const auditCase of [...singleSiteCases].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
        const applicableTargets = selectedTargets.filter((target) => (
          auditCase.supportedProjects.includes(target.sourceComparativeTargetId)
        ));
        if (applicableTargets.length === 0) {
          omittedCases.push({
            pluginId: plugin.id,
            auditId: definition.id,
            caseId: auditCase.caseId,
            disposition: 'operator-target-omission',
          });
          continue;
        }
        selectedCaseIds.add(auditCase.caseId);
        includedCaseIds.push(auditCase.caseId);
        for (const target of applicableTargets.sort((left, right) => left.id.localeCompare(right.id))) {
          const executionId = `${auditCase.caseId}@${target.id}`;
          executionIds.push(executionId);
          executions.push({
            executionId,
            pluginId: plugin.id,
            auditId: definition.id,
            caseId: auditCase.caseId,
            entrySpec: auditCase.entrySpec,
            applicability: auditCase.applicability,
            targetId: target.id,
            sourceComparativeTargetId: target.sourceComparativeTargetId,
            productOracleVariant: auditCase.oracleVariants.singleSite,
            productOracleExpected: isRecord(definition.standaloneOracle)
              ? definition.standaloneOracle.expected
              : definition.expected,
          });
        }
      }

      if (!definition.manual && singleSiteCases.length === 0) {
        coverageGaps.push({
          kind: 'missing-standalone-case',
          pluginId: plugin.id,
          auditId: definition.id,
          classification: definition.singleSiteClassification,
          detail: 'Selected automated Audit Definition has no executable Single-site Product Oracle variant.',
        });
      }
      selectedDefinitions.push({
        ...summary,
        selectedCaseIds: sortedStrings(includedCaseIds),
        executionIds: sortedStrings(executionIds),
      });
    }
  }

  executions.sort((left, right) => left.executionId.localeCompare(right.executionId));
  selectedDefinitions.sort((left, right) => left.auditId.localeCompare(right.auditId));
  omittedDefinitions.sort((left, right) => left.auditId.localeCompare(right.auditId));
  outsideMode.sort((left, right) => left.auditId.localeCompare(right.auditId));
  omittedCases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  coverageGaps.sort((left, right) => left.auditId.localeCompare(right.auditId));

  if (executions.length === 0) {
    const causes = [
      requestedComparisonOnly.length > 0
        ? `comparison-only: ${sortedStrings(requestedComparisonOnly).join(', ')}`
        : '',
      coverageGaps.length > 0
        ? `missing standalone variants: ${coverageGaps.map(({ auditId }) => auditId).join(', ')}`
        : '',
      omittedCases.length > 0
        ? `unsupported selected targets: ${sortedStrings(omittedCases.map(({ caseId }) => caseId)).join(', ')}`
        : '',
    ].filter(Boolean);
    throw new Error(
      `Single-site scope compiles to zero executable cases${causes.length > 0 ? ` (${causes.join('; ')})` : ''}; `
      + 'adjust definition, plugin, area, or target selection.',
    );
  }

  const allEligibleDefinitionsSelected = omittedDefinitions.length === 0;
  const allEligibleCasesSelected = omittedCases.length === 0;
  const derivedQualifier = allEligibleDefinitionsSelected && allEligibleCasesSelected && requiredTargetsSelected
    ? 'FULL'
    : 'TARGETED';
  const body = {
    schemaVersion: DEFINITION_COVERAGE_MANIFEST_SCHEMA_VERSION,
    kind: 'definition-coverage-manifest',
    mode: 'single-site',
    deployment: {
      url: contract.url,
      deploymentRole: contract.deploymentRole,
      certificatePolicy: contract.certificatePolicy,
      identityFingerprint: preflight.identityFingerprint,
      revision: preflight.deploymentRevision,
      evidenceAuthority: preflight.evidenceAuthority,
    },
    revisions: {
      runContract: canonicalSha256(contract),
      pluginRegistry: canonicalSha256(pluginRegistry),
      targetRegistry: canonicalSha256(targetRegistry),
      runner: runnerRevision.trim(),
    },
    scope: {
      requestedQualifier: contract.scope.qualifier,
      qualifier: derivedQualifier,
      filters: {
        pluginIds: sortedStrings(contract.scope.pluginIds),
        auditIds: sortedStrings(contract.scope.auditIds),
        areas: sortedStrings(contract.scope.areas),
      },
      selectedTargetIds: sortedStrings(contract.targetIds),
      requiredFullProfileTargetIds: sortedStrings(fullProfileTargetIds),
      allEligibleDefinitionsSelected,
      allEligibleCasesSelected,
      allRequiredTargetsSelected: requiredTargetsSelected,
    },
    coverageStatus: coverageGaps.length > 0 ? 'GAPS' : 'COMPLETE',
    selectedTargets: selectedTargets.map(targetSummary).sort((left, right) => left.targetId.localeCompare(right.targetId)),
    selectedDefinitions,
    executions,
    coverageGaps,
    omissions: {
      definitions: omittedDefinitions,
      cases: omittedCases,
      targets: omittedTargets,
    },
    outsideMode,
    counts: {
      selectedDefinitions: selectedDefinitions.length,
      executableCases: selectedCaseIds.size,
      plannedExecutions: executions.length,
      manualDefinitions: selectedDefinitions.filter(({ manual }) => manual).length,
      coverageGaps: coverageGaps.length,
      omittedDefinitions: omittedDefinitions.length,
      outsideModeDefinitions: outsideMode.length,
    },
  };
  return { ...body, manifestDigest: canonicalSha256(body) };
}

export function verifyDefinitionCoverageManifest(manifest) {
  if (!isRecord(manifest) || !nonEmptyString(manifest.manifestDigest)) return false;
  const { manifestDigest, ...body } = manifest;
  return manifestDigest === canonicalSha256(body);
}
