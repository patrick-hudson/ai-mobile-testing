import {
  assertDigest,
  canonicalDigest,
  canonicalJson,
  exactKeys,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
} from './canonical-contract.mjs';
import { compileCanonicalExecutionGraph, compileSingleSiteInventoryBarrier, parseCanonicalExecutionGraph } from './execution-graph-compiler.mjs';
import { parseReleaseSubjectCore, sealReleaseSubjectCore } from './release-subject.mjs';
import { parseRunContract } from './run-contract.mjs';
import { sealCompileRiskInputs } from './risk-source-observation.mjs';
import { sealWorkExecutionDescriptor } from './work-execution-descriptor.mjs';

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateIntent(value) {
  exactKeys(value, ['schemaVersion', 'runContract'], 'Launch intent');
  if (value.schemaVersion !== 1) failContract('UNSUPPORTED_SCHEMA_VERSION', 'Launch intent must use schemaVersion 1.');
  return parseRunContract(value.runContract);
}

function targetCatalog(mode, registry) {
  if (!isRecord(registry) || registry.schemaVersion !== 1) {
    failContract('UNSUPPORTED_SCHEMA_VERSION', 'Target registry must use schemaVersion 1.');
  }
  const targets = mode === 'single-site' ? registry.singleSiteTargets : registry.localTargets;
  const fullIds = mode === 'single-site' ? registry.singleSiteFullProfileTargetIds : registry.defaultTargetIds;
  if (!Array.isArray(targets) || !Array.isArray(fullIds) || targets.length === 0 || fullIds.length === 0) {
    failContract('INVALID_CONTRACT', `Target registry lacks a non-empty ${mode} target catalog and FULL profile.`);
  }
  const byId = new Map();
  for (const target of targets) {
    const id = nonEmptyString(target?.id, `${mode} target.id`);
    if (byId.has(id)) failContract('DUPLICATE_EXECUTION_ID', `Target ${id} is duplicated.`);
    if (mode === 'single-site') nonEmptyString(target.sourceComparativeTargetId, `${id}.sourceComparativeTargetId`);
    if (mode === 'comparative' && !['candidate', 'production'].includes(target.environment)) {
      failContract('INVALID_CONTRACT', `Comparative target ${id} has no canonical environment.`);
    }
    byId.set(id, target);
  }
  if (fullIds.some((id) => !byId.has(id))) failContract('INVALID_CONTRACT', 'FULL target profile contains unknown targets.');
  return { byId, fullIds: sortedUnique(fullIds) };
}

function pluginCatalog(registry) {
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)
    || registry.plugins.length === 0) {
    failContract('UNSUPPORTED_SCHEMA_VERSION', 'Plugin registry must use schemaVersion 1 and contain plugins.');
  }
  const plugins = new Map();
  const definitions = new Map();
  for (const plugin of registry.plugins) {
    const pluginId = nonEmptyString(plugin?.id, 'plugin.id');
    if (plugins.has(pluginId) || !Array.isArray(plugin.auditDefinitions) || !Array.isArray(plugin.auditCases)) {
      failContract('INVALID_CONTRACT', `Plugin ${pluginId} is duplicated or malformed.`);
    }
    plugins.set(pluginId, plugin);
    for (const definition of plugin.auditDefinitions) {
      const id = nonEmptyString(definition?.id, `${pluginId}.auditDefinition.id`);
      if (definitions.has(id) || !nonEmptyString(definition.area, `${id}.area`)
        || !['standalone-compatible', 'standalone-required', 'comparison-only'].includes(definition.singleSiteClassification)) {
        failContract('INVALID_CONTRACT', `Audit Definition ${id} is duplicated or malformed.`);
      }
      definitions.set(id, { ...definition, pluginId, cases: [] });
    }
    for (const auditCase of plugin.auditCases) {
      const definition = definitions.get(auditCase?.auditId);
      if (!definition || !nonEmptyString(auditCase.caseId, 'auditCase.caseId')
        || !Array.isArray(auditCase.supportedModes) || !Array.isArray(auditCase.supportedProjects)) {
        failContract('INVALID_CONTRACT', `Plugin ${pluginId} contains an invalid executable case.`);
      }
      definition.cases.push(auditCase);
    }
  }
  return { plugins, definitions };
}

function selectedByFilters(definition, scope) {
  return scope.pluginIds.length === 0 && scope.auditIds.length === 0 && scope.areas.length === 0
    || scope.pluginIds.includes(definition.pluginId)
    || scope.auditIds.includes(definition.id)
    || scope.areas.includes(definition.area);
}

function validateFilters(scope, catalog) {
  const areas = new Set([...catalog.definitions.values()].map(({ area }) => area));
  const unknown = [
    ...scope.pluginIds.filter((id) => !catalog.plugins.has(id)).map((id) => `plugin ${id}`),
    ...scope.auditIds.filter((id) => !catalog.definitions.has(id)).map((id) => `audit ${id}`),
    ...scope.areas.filter((id) => !areas.has(id)).map((id) => `area ${id}`),
  ];
  if (unknown.length > 0) failContract('AUTHORITY_SCOPE_MISMATCH', `Launch scope references unknown ${unknown.join(', ')}.`);
}

function executableOnTargets(definition, mode, targets) {
  if (definition.manual === true) return false;
  if (mode === 'single-site' && definition.singleSiteClassification === 'comparison-only') return false;
  return definition.cases.some((auditCase) => auditCase.supportedModes.includes(mode)
    && targets.some((target) => auditCase.supportedProjects.includes(
      mode === 'single-site' ? target.sourceComparativeTargetId : target.id,
    )));
}

function definitionSupportsTarget(definition, mode, target) {
  return definition.manual !== true
    && !(mode === 'single-site' && definition.singleSiteClassification === 'comparison-only')
    && definition.cases.some((auditCase) => auditCase.supportedModes.includes(mode)
      && auditCase.supportedProjects.includes(mode === 'single-site' ? target.sourceComparativeTargetId : target.id));
}

function resolveAuthority(contract, plugins, targets) {
  validateFilters(contract.scope, plugins);
  const unknownTargets = contract.targetIds.filter((id) => !targets.byId.has(id));
  if (unknownTargets.length > 0) {
    failContract('AUTHORITY_SCOPE_MISMATCH', `Launch selects unknown targets: ${unknownTargets.join(', ')}.`);
  }
  const selectedTargetIds = sortedUnique(contract.targetIds);
  if (contract.scope.qualifier === 'FULL'
    && canonicalJson(selectedTargetIds) !== canonicalJson(targets.fullIds)) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'FULL launch target scope must exactly match the server FULL target profile.');
  }
  const selectedTargets = selectedTargetIds.map((id) => targets.byId.get(id));
  if (contract.mode === 'comparative') {
    const roles = new Set(selectedTargets.map(({ environment }) => environment));
    if (!roles.has('candidate') || !roles.has('production')) {
      failContract('AUTHORITY_SCOPE_MISMATCH',
        'Comparative authority requires at least one candidate target and one production target.');
    }
  }
  const selectedDefinitions = [...plugins.definitions.values()]
    .filter((definition) => selectedByFilters(definition, contract.scope))
    .filter((definition) => executableOnTargets(definition, contract.mode, selectedTargets))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (selectedDefinitions.length === 0) {
    failContract('EMPTY_EXECUTION_MANIFEST', 'Launch scope compiles to no executable automated definitions.');
  }
  const nonExecutableTargets = selectedTargets
    .filter((target) => !selectedDefinitions.some((definition) => definitionSupportsTarget(definition, contract.mode, target)))
    .map(({ id }) => id);
  if (nonExecutableTargets.length > 0) {
    failContract('AUTHORITY_SCOPE_MISMATCH',
      `Launch target scope contains no executable automated work for: ${nonExecutableTargets.join(', ')}.`);
  }
  if (contract.scope.qualifier === 'FULL') {
    const allEligible = [...plugins.definitions.values()]
      .filter((definition) => executableOnTargets(definition, contract.mode, selectedTargets))
      .map(({ id }) => id).sort();
    if (canonicalJson(selectedDefinitions.map(({ id }) => id)) !== canonicalJson(allEligible)) {
      failContract('AUTHORITY_SCOPE_MISMATCH', 'FULL definition scope is not executable and complete.');
    }
  }
  return {
    qualifier: contract.scope.qualifier,
    scope: {
      features: sortedUnique(selectedDefinitions.map(({ area }) => area)),
      definitions: selectedDefinitions.map(({ id }) => id),
      targets: selectedTargetIds,
      knownLimits: contract.mode === 'single-site' && contract.certificatePolicy === 'preview-bypass'
        ? ['development-certificate-bypass'] : [],
    },
  };
}

function compileRiskInputs(contract, plugins, subjectCore) {
  const severity = (value) => ({ P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' }[value] ?? 'medium');
  const manualObligations = [...plugins.definitions.values()]
    .filter((definition) => definition.manual === true)
    .filter((definition) => selectedByFilters(definition, contract.scope))
    .filter((definition) => contract.mode === 'comparative'
      || definition.singleSiteClassification !== 'comparison-only')
    .map((definition) => ({
      id: definition.id,
      severity: severity(definition.severity),
      explanation: nonEmptyString(definition.expected, `${definition.id}.expected`),
      recommendedAction: `Complete the manual ${nonEmptyString(definition.title, `${definition.id}.title`)} check and retain its evidence.`,
    }));
  return sealCompileRiskInputs({
    schemaVersion: 1,
    subjectCoreDigest: subjectCore.digest,
    manualObligations,
  });
}

function releaseTargets(contract) {
  return contract.mode === 'single-site'
    ? [{ role: contract.deploymentRole, origin: contract.url }]
    : [
      { role: 'candidate', origin: contract.candidateUrl },
      { role: 'production', origin: contract.productionUrl },
    ];
}

function descriptorOrigins(subjectCore) {
  const byRole = new Map(subjectCore.targets.map(({ role, origin }) => [role, origin]));
  return subjectCore.mode === 'single-site'
    ? { candidate: subjectCore.targets[0].origin, production: null }
    : { candidate: byRole.get('candidate'), production: byRole.get('production') };
}

function scheduledWorkItem(plan, maxAttempts, subjectCore, runnerRevision) {
  const inventory = plan.capability === 'inventory:http';
  const executionDescriptor = sealWorkExecutionDescriptor({
    workItemId: plan.id,
    subjectCoreDigest: subjectCore.digest,
    runnerRevision,
    mode: subjectCore.mode,
    operation: inventory ? 'inventory' : 'playwright',
    definitionId: plan.definitionId,
    pluginId: inventory ? null : plan.pluginId,
    caseId: inventory ? null : plan.caseId,
    entrySpec: inventory ? null : plan.entrySpec,
    targetId: plan.targetId,
    targetRole: plan.targetRole,
    capability: plan.capability,
    resourceClass: plan.resourceClass,
    origins: descriptorOrigins(subjectCore),
    certificatePolicy: subjectCore.certificatePolicy,
    route: plan.routeUrl ? {
      inventoryDigest: plan.inventoryDigest,
      url: plan.routeUrl,
      path: plan.routePath,
      sources: plan.routeSources,
      productOracleVariant: plan.productOracleVariant,
    } : null,
  });
  return {
    id: plan.id,
    maxAttempts,
    capability: plan.capability,
    resourceClass: plan.resourceClass,
    targetId: plan.targetId,
    specAffinity: plan.entrySpec ?? null,
    executionDescriptor,
  };
}

export function scheduleCanonicalWorkItems({ executionGraph: rawGraph, subjectCore: rawSubjectCore, runnerRevision }) {
  const executionGraph = parseCanonicalExecutionGraph(rawGraph);
  const subjectCore = parseReleaseSubjectCore(rawSubjectCore);
  runnerRevision = assertDigest(runnerRevision, 'runnerRevision');
  if (executionGraph.subjectCoreDigest !== subjectCore.digest) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Scheduled canonical work does not match its release subject core.');
  }
  return freezeContract([...executionGraph.workItemPlans, ...executionGraph.contextPlans]
    .map((plan) => scheduledWorkItem(plan, plan.resourceClass === 'performance' ? 2 : 3, subjectCore, runnerRevision))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export function compileSharedLaunchPlan(input) {
  exactKeys(input, [
    'intent', 'pluginRegistry', 'targetRegistry', 'runnerRevision', 'configurationRevision',
    'environmentRevision', 'deploymentIdentity',
  ], 'Shared launch compiler input');
  const contract = validateIntent(input.intent);
  const runnerRevision = assertDigest(input.runnerRevision, 'runnerRevision');
  const configurationRevision = assertDigest(input.configurationRevision, 'configurationRevision');
  const environmentRevision = assertDigest(input.environmentRevision, 'environmentRevision');
  const plugins = pluginCatalog(input.pluginRegistry);
  const targets = targetCatalog(contract.mode, input.targetRegistry);
  const requestedAuthority = resolveAuthority(contract, plugins, targets);
  const subjectCore = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: input.deploymentIdentity,
    targets: releaseTargets(contract),
    mode: contract.mode,
    requestedAuthority,
    revisions: {
      runner: runnerRevision,
      plugins: canonicalDigest(input.pluginRegistry),
      targets: canonicalDigest(input.targetRegistry),
      configuration: configurationRevision,
    },
    environmentIdentity: environmentRevision,
    certificatePolicy: contract.mode === 'single-site' ? contract.certificatePolicy : 'strict',
  });
  const sealedCompileRiskInputs = compileRiskInputs(contract, plugins, subjectCore);
  let state;
  let executionGraph;
  let inventoryBarrier;
  let createParentRunInput;
  if (contract.mode === 'single-site') {
    inventoryBarrier = compileSingleSiteInventoryBarrier({
      subjectCore, pluginRegistry: input.pluginRegistry, targetRegistry: input.targetRegistry, maxAttempts: 3,
    });
    state = 'pending-inventory';
    executionGraph = null;
    createParentRunInput = {
      subjectCore,
      subjectCoreDigest: subjectCore.digest,
      compilationState: 'pending',
      runnerRevision,
      sealedCompileRiskInputs,
      inventoryBarrier,
      workItems: [scheduledWorkItem(inventoryBarrier.workItem, inventoryBarrier.maxAttempts, subjectCore, runnerRevision)],
    };
  } else {
    inventoryBarrier = null;
    executionGraph = compileCanonicalExecutionGraph({
      subjectCore,
      pluginRegistry: input.pluginRegistry,
      targetRegistry: input.targetRegistry,
      deploymentIdentityRecheck: input.deploymentIdentity,
    });
    state = 'sealed';
    createParentRunInput = {
      subjectCore,
      subjectCoreDigest: subjectCore.digest,
      executionManifest: executionGraph.executionManifest,
      executionManifestDigest: executionGraph.executionManifest.digest,
      finalSubject: executionGraph.finalSubject,
      finalSubjectDigest: executionGraph.finalSubject.digest,
      compilationState: 'sealed',
      runnerRevision,
      sealedCompileRiskInputs,
      inventoryBarrier: null,
      workItems: scheduleCanonicalWorkItems({ executionGraph, subjectCore, runnerRevision }),
    };
  }
  const body = {
    schemaVersion: 1,
    kind: 'shared-launch-plan',
    intentDigest: canonicalDigest(input.intent),
    state,
    subjectCore,
    inventoryBarrier,
    executionGraph,
    createParentRunInput,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}
