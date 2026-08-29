import {
  canonicalDigest,
  canonicalJson,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
} from './canonical-contract.mjs';
import { parseExecutionManifest, sealExecutionManifest } from './execution-contract.mjs';
import { parseFinalReleaseSubject, parseReleaseSubjectCore, sealFinalReleaseSubject } from './release-subject.mjs';

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function registryRevision(registry, label) {
  if (!isRecord(registry) || registry.schemaVersion !== 1) {
    failContract('UNSUPPORTED_SCHEMA_VERSION', `${label} must use schemaVersion 1.`);
  }
  return canonicalDigest(registry);
}

function validateRegistries(subjectCore, pluginRegistry, targetRegistry) {
  const pluginRevision = registryRevision(pluginRegistry, 'Plugin registry');
  const targetRevision = registryRevision(targetRegistry, 'Target registry');
  if (!Array.isArray(pluginRegistry.plugins) || pluginRegistry.plugins.length === 0) {
    failContract('INVALID_CONTRACT', 'Plugin registry must contain at least one plugin.');
  }
  if (pluginRevision !== subjectCore.revisions.plugins || targetRevision !== subjectCore.revisions.targets) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Compiler registries do not match the revisions sealed into the subject core.');
  }
}

function catalog(pluginRegistry) {
  const definitions = new Map();
  const casesByDefinition = new Map();
  const caseIds = new Set();
  for (const plugin of pluginRegistry.plugins) {
    nonEmptyString(plugin?.id, 'plugin.id');
    if (!Array.isArray(plugin.auditDefinitions) || !Array.isArray(plugin.auditCases)) {
      failContract('INVALID_CONTRACT', `Plugin ${plugin.id} must declare auditDefinitions and auditCases.`);
    }
    for (const definition of plugin.auditDefinitions) {
      const id = nonEmptyString(definition?.id, `${plugin.id}.auditDefinition.id`);
      if (definitions.has(id)) failContract('DUPLICATE_EXECUTION_ID', `Audit Definition ${id} is duplicated.`);
      if (!nonEmptyString(definition.area, `${id}.area`)
        || !['standalone-compatible', 'standalone-required', 'comparison-only'].includes(definition.singleSiteClassification)) {
        failContract('INVALID_CONTRACT', `Audit Definition ${id} lacks canonical area or Single-site classification metadata.`);
      }
      definitions.set(id, { ...definition, pluginId: plugin.id });
      casesByDefinition.set(id, []);
    }
    for (const auditCase of plugin.auditCases) {
      const caseId = nonEmptyString(auditCase?.caseId, `${plugin.id}.auditCase.caseId`);
      const definitionId = nonEmptyString(auditCase.auditId, `${caseId}.auditId`);
      if (!definitions.has(definitionId) || !nonEmptyString(auditCase.entrySpec, `${caseId}.entrySpec`)
        || !nonEmptyString(auditCase.applicability, `${caseId}.applicability`)
        || !Array.isArray(auditCase.supportedModes) || !Array.isArray(auditCase.supportedProjects)
        || !isRecord(auditCase.oracleVariants)) {
        failContract('INVALID_CONTRACT', `Executable case ${caseId} lacks canonical definition, mode, target, or Product Oracle metadata.`);
      }
      if (caseIds.has(caseId)) failContract('DUPLICATE_EXECUTION_ID', `Executable case ${caseId} is duplicated.`);
      caseIds.add(caseId);
      for (const mode of auditCase.supportedModes) {
        if (!['single-site', 'comparative'].includes(mode)
          || !nonEmptyString(auditCase.oracleVariants[mode === 'single-site' ? 'singleSite' : 'comparative'], `${caseId}.${mode} Product Oracle`)) {
          failContract('INVALID_CONTRACT', `Executable case ${caseId} has an invalid ${mode} Product Oracle binding.`);
        }
      }
      const existing = casesByDefinition.get(definitionId);
      if (existing.some((entry) => entry.caseId === caseId)) {
        failContract('DUPLICATE_EXECUTION_ID', `Executable case ${caseId} is duplicated.`);
      }
      existing.push({ ...auditCase, pluginId: plugin.id });
    }
  }
  return { definitions, casesByDefinition };
}

function targetCatalog(mode, targetRegistry) {
  const source = mode === 'single-site' ? targetRegistry.singleSiteTargets : targetRegistry.localTargets;
  const fullIds = mode === 'single-site'
    ? targetRegistry.singleSiteFullProfileTargetIds
    : targetRegistry.defaultTargetIds;
  if (!Array.isArray(source) || !Array.isArray(fullIds) || source.length === 0 || fullIds.length === 0) {
    failContract('INVALID_CONTRACT', `Target registry does not define ${mode} targets and a full profile.`);
  }
  const byId = new Map();
  for (const target of source) {
    const id = nonEmptyString(target?.id, `${mode} target.id`);
    if (byId.has(id)) failContract('DUPLICATE_EXECUTION_ID', `Target ${id} is duplicated.`);
    if (mode === 'comparative' && !['candidate', 'production'].includes(target.environment)) {
      failContract('INVALID_CONTRACT', `Comparative target ${id} must identify candidate or production environment.`);
    }
    const baselineTargetId = target.baselineTargetId ?? null;
    if (mode === 'comparative' && baselineTargetId !== null
      && (target.environment !== 'candidate' || !nonEmptyString(baselineTargetId, `${id}.baselineTargetId`))) {
      failContract('INVALID_CONTRACT', `Comparative target ${id} has an invalid production baseline binding.`);
    }
    if (mode === 'single-site') nonEmptyString(target.sourceComparativeTargetId, `${id}.sourceComparativeTargetId`);
    byId.set(id, mode === 'comparative' ? { ...target, baselineTargetId } : target);
  }
  const unknownFullIds = fullIds.filter((id) => !byId.has(id));
  if (unknownFullIds.length > 0) failContract('INVALID_CONTRACT', `Full target profile contains unknown IDs: ${unknownFullIds.join(', ')}.`);
  if (mode === 'comparative') {
    for (const target of byId.values()) {
      if (target.environment === 'candidate' && target.baselineTargetId !== null
        && byId.get(target.baselineTargetId)?.environment !== 'production') {
        failContract('INVALID_CONTRACT', `Comparative target ${target.id} references an unknown production baseline target.`);
      }
    }
  }
  return { byId, fullIds: sortedUnique(fullIds) };
}

function inventoryBinding(subjectCore, routeInventory) {
  if (subjectCore.mode !== 'single-site') {
    if (routeInventory !== undefined && routeInventory !== null) {
      failContract('INVALID_CONTRACT', 'Comparative compilation must not accept a Single-site route inventory.');
    }
    return null;
  }
  if (!isRecord(routeInventory) || routeInventory.schemaVersion !== 1 || !Array.isArray(routeInventory.routes)) {
    failContract('INVENTORY_REQUIRED', 'Single-site compilation requires one completed schemaVersion 1 route inventory barrier.');
  }
  const auditedOrigin = subjectCore.targets[0]?.origin;
  if (subjectCore.targets.length !== 1 || routeInventory.origin !== auditedOrigin) {
    failContract('INVENTORY_BINDING_MISMATCH', 'Route inventory origin must match the sole audited subject origin.');
  }
  if (!Array.isArray(routeInventory.limitations) || !Array.isArray(routeInventory.failures)) {
    failContract('INVENTORY_BINDING_MISMATCH', 'Route inventory must retain explicit limitation and failure collections.');
  }
  const routeUrls = new Set();
  for (const [index, route] of routeInventory.routes.entries()) {
    if (!isRecord(route) || !nonEmptyString(route.url, `routeInventory.routes[${index}].url`)
      || !nonEmptyString(route.path, `routeInventory.routes[${index}].path`)
      || typeof route.query !== 'string' || !Array.isArray(route.sources)
      || !['included', 'fetch-failed', 'unreachable', 'non-html'].includes(route.disposition)) {
      failContract('INVENTORY_BINDING_MISMATCH', `Route inventory entry ${index} is malformed.`);
    }
    let parsed;
    try { parsed = new URL(route.url); } catch { failContract('INVENTORY_BINDING_MISMATCH', `Route inventory entry ${index} URL is invalid.`); }
    if (parsed.origin !== auditedOrigin || route.path !== parsed.pathname || route.query !== parsed.search) {
      failContract('INVENTORY_BINDING_MISMATCH', `Route inventory entry ${index} escaped or contradicts the audited origin.`);
    }
    if (routeUrls.has(route.url)) failContract('INVENTORY_BINDING_MISMATCH', `Route inventory duplicates ${route.url}.`);
    routeUrls.add(route.url);
  }
  const includedRoutes = routeInventory.routes.filter(({ disposition }) => disposition === 'included');
  if (includedRoutes.length === 0) {
    failContract('EMPTY_EXECUTION_MANIFEST', 'Route inventory must retain at least one included route before graph sealing.');
  }
  return freezeContract({
    schemaVersion: 1,
    kind: 'route-inventory-binding',
    inventoryDigest: canonicalDigest(routeInventory),
    origin: routeInventory.origin,
    includedRouteCount: includedRoutes.length,
  });
}

function parseInventoryBarrier(value, subjectCore) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'single-site-inventory-barrier'
    || value.subjectCoreDigest !== subjectCore.digest || !isRecord(value.workItem)
    || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1) {
    failContract('INVENTORY_BINDING_MISMATCH', 'Inventory barrier is invalid or belongs to another subject core.');
  }
  const { digest, ...body } = value;
  if (canonicalDigest(body) !== digest) failContract('INVENTORY_BINDING_MISMATCH', 'Inventory barrier digest is corrupt.');
  return value;
}

export function parseSingleSiteInventoryBarrier(value, rawSubjectCore) {
  return parseInventoryBarrier(value, parseReleaseSubjectCore(rawSubjectCore));
}

export function compileSingleSiteInventoryBarrier({ subjectCore: rawSubjectCore, pluginRegistry, targetRegistry, maxAttempts = 3 }) {
  const subjectCore = parseReleaseSubjectCore(rawSubjectCore);
  if (subjectCore.mode !== 'single-site') failContract('INVALID_CONTRACT', 'Inventory barriers exist only for Single-site graphs.');
  validateRegistries(subjectCore, pluginRegistry, targetRegistry);
  const targets = targetCatalog('single-site', targetRegistry);
  const selectedTargetIds = subjectCore.requestedAuthority.scope.targets;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    failContract('INVALID_CONTRACT', 'Inventory maxAttempts must be an integer from 1 through 10.');
  }
  if (selectedTargetIds.some((id) => !targets.byId.has(id))) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Inventory barrier target scope references an unknown Single-site target.');
  }
  const targetId = [...selectedTargetIds].sort()[0];
  const body = {
    schemaVersion: 1,
    kind: 'single-site-inventory-barrier',
    subjectCoreDigest: subjectCore.digest,
    workItem: {
      id: durableExecutionId('inventory-single-site', {
        kind: 'single-site-inventory',
        subjectCoreDigest: subjectCore.digest,
      }),
      definitionId: 'INVENTORY',
      targetId,
      targetRole: subjectCore.targets[0].role,
      capability: 'inventory:http',
      resourceClass: 'ordinary',
    },
    maxAttempts,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function nextSingleSiteInventoryAttempt({ subjectCore: rawSubjectCore, barrier: rawBarrier, failedAttempt, sealedGraph = null }) {
  const subjectCore = parseReleaseSubjectCore(rawSubjectCore);
  const barrier = parseInventoryBarrier(rawBarrier, subjectCore);
  if (sealedGraph !== null) failContract('INVENTORY_ALREADY_SEALED', 'Inventory cannot retry after the canonical execution graph is sealed.');
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1 || failedAttempt >= barrier.maxAttempts) {
    failContract('INVENTORY_RECOVERY_EXHAUSTED', 'Inventory has no bounded retry remaining.');
  }
  return freezeContract({
    schemaVersion: 1,
    kind: 'single-site-inventory-attempt',
    subjectCoreDigest: subjectCore.digest,
    barrierDigest: barrier.digest,
    workItemId: barrier.workItem.id,
    attempt: failedAttempt + 1,
  });
}

export function completeSingleSiteInventoryBarrier({
  subjectCore: rawSubjectCore,
  barrier: rawBarrier,
  attempt,
  manualRekicks = 0,
  routeInventory,
  deploymentIdentityRecheck,
}) {
  const subjectCore = parseReleaseSubjectCore(rawSubjectCore);
  const barrier = parseInventoryBarrier(rawBarrier, subjectCore);
  if (!Number.isSafeInteger(manualRekicks) || manualRekicks < 0 || manualRekicks > 3
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > barrier.maxAttempts + manualRekicks) {
    failContract('INVENTORY_RECOVERY_EXHAUSTED', 'Inventory completion attempt is outside its bounded recovery budget.');
  }
  const inventory = inventoryBinding(subjectCore, routeInventory);
  if (canonicalJson(deploymentIdentityRecheck) !== canonicalJson(subjectCore.deploymentIdentity)) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Deployment identity changed while inventory was running.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'single-site-inventory-completion',
    subjectCoreDigest: subjectCore.digest,
    barrier,
    attempt,
    ...(manualRekicks > 0 ? { manualRekicks } : {}),
    inventory,
    routeInventory,
    deploymentIdentityRecheck,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

function parseInventoryCompletion(value, subjectCore) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'single-site-inventory-completion'
    || value.subjectCoreDigest !== subjectCore.digest || !isRecord(value.inventory) || !isRecord(value.barrier)) {
    failContract('INVENTORY_BINDING_MISMATCH', 'Inventory completion is invalid or belongs to another subject core.');
  }
  const { digest, ...body } = value;
  const barrier = parseInventoryBarrier(value.barrier, subjectCore);
  const manualRekicks = value.manualRekicks ?? 0;
  if (!Number.isSafeInteger(manualRekicks) || manualRekicks < 0 || manualRekicks > 3
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > barrier.maxAttempts + manualRekicks
    || canonicalDigest(body) !== digest
    || inventoryBinding(subjectCore, value.routeInventory).inventoryDigest !== value.inventory.inventoryDigest) {
    failContract('INVENTORY_BINDING_MISMATCH', 'Inventory completion digest or route binding is corrupt.');
  }
  return value;
}

function targetRole(mode, subjectCore, target) {
  return mode === 'single-site' ? subjectCore.targets[0].role : target.environment;
}

function targetSupportsCase(mode, target, auditCase) {
  const registryTargetId = mode === 'single-site' ? target.sourceComparativeTargetId : target.id;
  return auditCase.supportedProjects.includes(registryTargetId);
}

function durableExecutionId(prefix, identity) {
  return `${prefix}-${canonicalDigest(identity).slice('sha256:'.length)}`;
}

function manifestOracleExecution(oraclePlan, workPlans) {
  const workById = new Map(workPlans.map((plan) => [plan.id, plan]));
  return {
    id: oraclePlan.id,
    definitionId: oraclePlan.definitionId,
    productOracleVariant: oraclePlan.productOracleVariant,
    baselinePolicy: oraclePlan.baselinePolicy,
    requiredWorkItemIds: oraclePlan.requiredWorkItemIds,
    workItemBindings: oraclePlan.requiredWorkItemIds.map((workItemId) => {
      const plan = workById.get(workItemId);
      if (!plan) failContract('UNDECLARED_WORK_ITEM', `Oracle ${oraclePlan.id} references missing work plan ${workItemId}.`);
      return { workItemId, targetRole: plan.targetRole, comparisonKey: plan.comparisonKey };
    }),
  };
}

function schedulingClass(target, auditCase) {
  if (String(auditCase.entrySpec).includes('performance')) {
    return { capability: 'performance:lighthouse', resourceClass: 'performance' };
  }
  const engine = target.requiredCapability ?? nonEmptyString(target.engine, `${target.id}.engine`);
  return {
    capability: String(engine).includes(':') ? String(engine) : `browser:${engine}`,
    resourceClass: 'ordinary',
  };
}

function workPlan({ mode, definition, auditCase, target, role, inventory }) {
  const id = durableExecutionId(`work-${mode}`, {
    kind: 'canonical-work-item',
    mode,
    definitionId: definition.id,
    caseId: auditCase.caseId,
    targetId: target.id,
    inventoryDigest: inventory?.inventoryDigest ?? null,
  });
  const { capability, resourceClass } = schedulingClass(target, auditCase);
  return {
    id,
    definitionId: definition.id,
    pluginId: definition.pluginId,
    caseId: auditCase.caseId,
    entrySpec: auditCase.entrySpec,
    applicability: auditCase.applicability,
    targetId: target.id,
    targetRole: role,
    comparisonKey: mode === 'comparative' && role === 'candidate'
      ? (target.baselineTargetId ?? target.id)
      : target.id,
    capability,
    resourceClass,
    productOracleVariant: auditCase.oracleVariants[mode === 'single-site' ? 'singleSite' : 'comparative'],
    productOracleExpected: mode === 'single-site'
      ? (definition.standaloneOracle?.expected ?? definition.expected)
      : definition.expected,
    inventoryDigest: inventory?.inventoryDigest ?? null,
  };
}

function appendGenericRoutePlans({ subjectCore, modeCatalog, completedInventory, definitions, selectedTargets, workItemPlans, oraclePlans }) {
  if (!completedInventory || !definitions.some(({ id }) => id === 'ENV-002')) return;
  const definition = modeCatalog.definitions.get('ENV-002');
  const target = selectedTargets.find(({ id }) => id === completedInventory.barrier.workItem.targetId);
  if (!target) failContract('INVENTORY_BINDING_MISMATCH', 'Inventory canonical target is outside the compiled authority scope.');
  const reviewedPaths = new Set([...modeCatalog.definitions.values()].flatMap(({ id, title }) => {
    const match = id.startsWith('PAGE-') && typeof title === 'string' ? /^Page audit: (\/[^?#]*)$/.exec(title.trim()) : null;
    return match ? [match[1] === '/' ? '/' : match[1].replace(/\/$/, '')] : [];
  }));
  for (const route of completedInventory.routeInventory.routes
    .filter(({ disposition, path }) => disposition === 'included' && !reviewedPaths.has(path))
    .sort((left, right) => left.url.localeCompare(right.url))) {
    if (!Array.isArray(route.sources) || route.sources.length === 0) {
      failContract('INVENTORY_BINDING_MISMATCH', `Generic inventoried route ${route.url} lacks discovery provenance.`);
    }
    const caseId = `GENERIC-ROUTE-${canonicalDigest(['generic-route', route.url]).slice('sha256:'.length, 'sha256:'.length + 24).toUpperCase()}`;
    const auditCase = {
      caseId,
      entrySpec: 'tests/single-site-generic-route.spec.ts',
      applicability: 'candidate',
      oracleVariants: { singleSite: 'generic-page-inspection-v1' },
    };
    const plan = {
      ...workPlan({
        mode: 'single-site', definition, auditCase, target,
        role: subjectCore.targets[0].role, inventory: completedInventory.inventory,
      }),
      routeUrl: route.url,
      routePath: route.path,
      routeSources: route.sources,
    };
    workItemPlans.push(plan);
    oraclePlans.push({
      id: durableExecutionId('oracle-single-site', {
        kind: 'canonical-oracle-execution', mode: 'single-site', definitionId: definition.id, caseId, targetId: target.id,
      }),
      definitionId: definition.id,
      productOracleVariant: 'generic-page-inspection-v1',
      requiredWorkItemIds: [plan.id],
      baselinePolicy: 'not-applicable',
    });
  }
}

function assertAuthority(subjectCore, definitions, selectedTargets, modeCatalog, notApplicable) {
  const scope = subjectCore.requestedAuthority.scope;
  const selectedDefinitionIds = definitions.map(({ id }) => id).sort();
  const selectedTargetIds = selectedTargets.map(({ id }) => id).sort();
  const selectedFeatures = sortedUnique(definitions.map(({ area }) => area));
  if (canonicalJson(scope.definitions) !== canonicalJson(selectedDefinitionIds)
    || canonicalJson(scope.targets) !== canonicalJson(selectedTargetIds)
    || canonicalJson(scope.features) !== canonicalJson(selectedFeatures)) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Requested features, definitions, and targets must exactly match the compiled graph.');
  }
  if (subjectCore.certificatePolicy === 'preview-bypass'
    && !scope.knownLimits.includes('development-certificate-bypass')) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Development certificate bypass must be disclosed in certified scope known limits.');
  }
  if (subjectCore.requestedAuthority.qualifier === 'FULL') {
    const eligibleDefinitions = [...modeCatalog.definitions.values()]
      .filter((definition) => definition.manual !== true)
      .filter((definition) => subjectCore.mode === 'comparative' || definition.singleSiteClassification !== 'comparison-only')
      .filter((definition) => (modeCatalog.casesByDefinition.get(definition.id) ?? [])
        .some((auditCase) => auditCase.supportedModes.includes(subjectCore.mode)))
      .map(({ id }) => id).sort();
    if (canonicalJson(selectedDefinitionIds) !== canonicalJson(eligibleDefinitions)
      || canonicalJson(selectedTargetIds) !== canonicalJson(modeCatalog.targets.fullIds)) {
      failContract('AUTHORITY_SCOPE_MISMATCH', 'FULL authority requires every eligible automated definition and full-profile target.');
    }
  }
  return {
    selectedDefinitions: selectedDefinitionIds,
    selectedTargets: selectedTargetIds,
    excludedAsNotApplicable: notApplicable,
  };
}

export function compileCanonicalExecutionGraph({
  subjectCore: rawSubjectCore,
  pluginRegistry,
  targetRegistry,
  inventoryCompletion,
  deploymentIdentityRecheck,
}) {
  const subjectCore = parseReleaseSubjectCore(rawSubjectCore);
  validateRegistries(subjectCore, pluginRegistry, targetRegistry);
  const modeCatalog = catalog(pluginRegistry);
  const targets = targetCatalog(subjectCore.mode, targetRegistry);
  modeCatalog.targets = targets;
  const scope = subjectCore.requestedAuthority.scope;
  const unknownDefinitions = scope.definitions.filter((id) => !modeCatalog.definitions.has(id));
  const unknownTargets = scope.targets.filter((id) => !targets.byId.has(id));
  if (unknownDefinitions.length > 0 || unknownTargets.length > 0) {
    failContract('AUTHORITY_SCOPE_MISMATCH', `Requested scope references unknown definitions or targets: ${[...unknownDefinitions, ...unknownTargets].join(', ')}.`);
  }

  const definitions = scope.definitions.map((id) => modeCatalog.definitions.get(id));
  const selectedTargets = scope.targets.map((id) => targets.byId.get(id));
  const requestedNotApplicable = definitions
    .filter(({ singleSiteClassification }) => subjectCore.mode === 'single-site' && singleSiteClassification === 'comparison-only')
    .map(({ id }) => id);
  if (requestedNotApplicable.length > 0) {
    failContract('NOT_APPLICABLE_DEFINITION', `Comparison-only definitions are not applicable in Single-site mode: ${requestedNotApplicable.join(', ')}.`);
  }
  const notApplicable = subjectCore.mode === 'single-site'
    ? [...modeCatalog.definitions.values()]
      .filter(({ singleSiteClassification }) => singleSiteClassification === 'comparison-only')
      .map(({ id }) => id).sort()
    : [];
  const completedInventory = subjectCore.mode === 'single-site'
    ? parseInventoryCompletion(inventoryCompletion, subjectCore)
    : null;
  if (subjectCore.mode === 'comparative' && inventoryCompletion !== undefined && inventoryCompletion !== null) {
    failContract('INVALID_CONTRACT', 'Comparative compilation must not accept a Single-site inventory completion.');
  }
  const inventory = completedInventory?.inventory ?? null;
  const coverageBasis = assertAuthority(subjectCore, definitions, selectedTargets, modeCatalog, notApplicable);

  const workItemPlans = [];
  const oraclePlans = [];
  const contextPlans = [];
  for (const definition of definitions.sort((left, right) => left.id.localeCompare(right.id))) {
    if (definition.manual === true) continue;
    const cases = (modeCatalog.casesByDefinition.get(definition.id) ?? [])
      .filter(({ supportedModes }) => supportedModes.includes(subjectCore.mode))
      .sort((left, right) => left.caseId.localeCompare(right.caseId));
    for (const auditCase of cases) {
      const casePlans = selectedTargets
        .filter((target) => targetSupportsCase(subjectCore.mode, target, auditCase))
        .map((target) => workPlan({
          mode: subjectCore.mode,
          definition,
          auditCase,
          target,
          role: targetRole(subjectCore.mode, subjectCore, target),
          inventory,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (subjectCore.mode === 'single-site') {
        for (const plan of casePlans) {
          workItemPlans.push(plan);
          oraclePlans.push({
            id: durableExecutionId('oracle-single-site', {
              kind: 'canonical-oracle-execution', mode: 'single-site', definitionId: definition.id,
              caseId: auditCase.caseId, targetId: plan.targetId,
            }),
            definitionId: definition.id,
            productOracleVariant: plan.productOracleVariant,
            requiredWorkItemIds: [plan.id],
            baselinePolicy: 'not-applicable',
          });
        }
      } else if (casePlans.length > 0) {
        if (casePlans.some(({ targetRole: role }) => role === 'candidate')) {
          workItemPlans.push(...casePlans);
          oraclePlans.push({
            id: durableExecutionId('oracle-comparative', {
              kind: 'canonical-oracle-execution', mode: 'comparative', definitionId: definition.id, caseId: auditCase.caseId,
            }),
            definitionId: definition.id,
            productOracleVariant: auditCase.oracleVariants.comparative,
            requiredWorkItemIds: casePlans.map(({ id }) => id),
            baselinePolicy: 'context-unless-candidate-regression-proven',
          });
        } else {
          contextPlans.push(...casePlans.map((plan) => ({
            ...plan,
            authority: 'non-blocking-production-baseline-context',
          })));
        }
      }
    }
  }
  appendGenericRoutePlans({
    subjectCore, modeCatalog, completedInventory, definitions, selectedTargets, workItemPlans, oraclePlans,
  });
  workItemPlans.sort((left, right) => left.id.localeCompare(right.id));
  oraclePlans.sort((left, right) => left.id.localeCompare(right.id));
  contextPlans.sort((left, right) => left.id.localeCompare(right.id));
  if (workItemPlans.length === 0 || oraclePlans.length === 0) {
    failContract('EMPTY_EXECUTION_MANIFEST', 'Declared authority compiles to no required automated executions.');
  }
  const definitionIdsWithWork = sortedUnique(oraclePlans.map(({ definitionId }) => definitionId));
  if (canonicalJson(definitionIdsWithWork) !== canonicalJson(coverageBasis.selectedDefinitions)) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Certified definitions must each compile to required automated Product Oracle work.');
  }

  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: subjectCore.digest,
    workItems: [...workItemPlans, ...contextPlans]
      .map(({ id, definitionId, targetId, targetRole }) => ({ id, definitionId, targetId, targetRole })),
    oracleExecutions: oraclePlans.map((oraclePlan) => manifestOracleExecution(oraclePlan, workItemPlans)),
    contextWorkItemIds: contextPlans.map(({ id }) => id),
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore,
    executionManifest,
    grantedAuthority: subjectCore.requestedAuthority,
    coverageBasis,
    deploymentIdentityRecheck,
  });
  const body = {
    schemaVersion: 1,
    kind: 'canonical-execution-graph',
    mode: subjectCore.mode,
    subjectCoreDigest: subjectCore.digest,
    inventory,
    workItemPlans,
    oraclePlans,
    contextPlans,
    executionManifest,
    coverageBasis,
    finalSubject,
    finalSubjectDigest: finalSubject.digest,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function canonicalPlaywrightSelection(graph) {
  graph = parseCanonicalExecutionGraph(graph);
  const scheduledPlans = [...graph.workItemPlans, ...graph.contextPlans];
  return freezeContract({
    mode: graph.mode,
    caseIds: sortedUnique(scheduledPlans.map(({ caseId }) => caseId)),
    targetIds: sortedUnique(scheduledPlans.map(({ targetId }) => targetId)),
    executionIds: scheduledPlans.map(({ id }) => id).sort(),
    authoritativeExecutionIds: graph.workItemPlans.map(({ id }) => id).sort(),
    contextExecutionIds: graph.contextPlans.map(({ id }) => id).sort(),
  });
}

export function parseCanonicalExecutionGraph(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'canonical-execution-graph') {
    failContract('INVALID_CONTRACT', 'Canonical execution graph must use schemaVersion 1.');
  }
  const { digest, ...body } = value;
  if (canonicalDigest(body) !== digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Canonical execution graph digest is corrupt.');
  const executionManifest = parseExecutionManifest(value.executionManifest);
  const finalSubject = parseFinalReleaseSubject(value.finalSubject);
  if (executionManifest.digest !== finalSubject.executionManifestDigest
    || executionManifest.subjectCoreDigest !== value.subjectCoreDigest
    || finalSubject.digest !== value.finalSubjectDigest
    || finalSubject.mode !== value.mode
    || canonicalJson(finalSubject.coverageBasis) !== canonicalJson(value.coverageBasis)
    || !Array.isArray(value.workItemPlans) || !Array.isArray(value.oraclePlans) || !Array.isArray(value.contextPlans)) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Canonical execution graph contract bindings disagree.');
  }
  const plannedWork = [...value.workItemPlans, ...value.contextPlans]
    .map(({ id, definitionId, targetId, targetRole }) => ({ id, definitionId, targetId, targetRole }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const plannedOracles = value.oraclePlans.map((oraclePlan) => manifestOracleExecution(oraclePlan, value.workItemPlans));
  if (canonicalJson(plannedWork) !== canonicalJson(executionManifest.workItems)
    || canonicalJson(plannedOracles) !== canonicalJson(executionManifest.oracleExecutions)
    || canonicalJson(value.contextPlans.map(({ id }) => id).sort()) !== canonicalJson(executionManifest.contextWorkItemIds)) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Canonical graph plans disagree with the sealed execution manifest.');
  }
  return freezeContract(value);
}

export function compileIncompleteWorkRekick({ graph, incompleteWorkItemIds }) {
  graph = parseCanonicalExecutionGraph(graph);
  if (!isRecord(graph) || graph.kind !== 'canonical-execution-graph' || !Array.isArray(graph.workItemPlans)
    || !Array.isArray(incompleteWorkItemIds) || incompleteWorkItemIds.length === 0) {
    failContract('INVALID_CONTRACT', 'Incomplete-work rekick requires a sealed graph and non-empty work-item IDs.');
  }
  const uniqueIds = sortedUnique(incompleteWorkItemIds);
  if (uniqueIds.length !== incompleteWorkItemIds.length) failContract('DUPLICATE_EXECUTION_ID', 'Rekick work-item IDs must be unique.');
  const byId = new Map(graph.workItemPlans.map((plan) => [plan.id, plan]));
  const undeclared = uniqueIds.filter((id) => !byId.has(id));
  if (undeclared.length > 0) failContract('UNDECLARED_WORK_ITEM', `Rekick references undeclared work: ${undeclared.join(', ')}.`);
  const body = {
    schemaVersion: 1,
    kind: 'incomplete-work-rekick-plan',
    graphDigest: graph.digest,
    subjectCoreDigest: graph.subjectCoreDigest,
    executionManifestDigest: graph.executionManifest.digest,
    finalSubjectDigest: graph.finalSubjectDigest,
    inventoryDigest: graph.inventory?.inventoryDigest ?? null,
    workItemPlans: uniqueIds.map((id) => byId.get(id)),
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}
