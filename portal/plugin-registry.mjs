const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const AUDIT_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,79}$/;
const AREA_PATTERN = /^[a-z][a-z-]{1,39}$/;
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const EVIDENCE_TYPES = new Set(['video', 'screenshot', 'trace', 'json', 'axe', 'network', 'lighthouse']);
const EVIDENCE_POLICY_MODES = new Set(['interaction-video', 'static-screenshot', 'structured-data']);

function nonEmptyString(value, maximum = 2_000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validatedAuditDefinition(value, pluginId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !AUDIT_ID_PATTERN.test(value.id ?? '')
    || !AREA_PATTERN.test(value.area ?? '')
    || !nonEmptyString(value.title, 200)
    || !nonEmptyString(value.userPromise)
    || !SEVERITIES.has(value.severity)
    || typeof value.releaseBlocking !== 'boolean'
    || !nonEmptyString(value.expected)
    || !Array.isArray(value.evidence)
    || value.evidence.length === 0
    || value.evidence.some((kind) => !EVIDENCE_TYPES.has(kind))
    || new Set(value.evidence).size !== value.evidence.length
    || !value.evidencePolicy || typeof value.evidencePolicy !== 'object' || Array.isArray(value.evidencePolicy)
    || !EVIDENCE_POLICY_MODES.has(value.evidencePolicy.mode)
    || !nonEmptyString(value.evidencePolicy.rationale, 500)
    || (value.manual !== undefined && typeof value.manual !== 'boolean')) {
    throw new Error(`Installed test plugin ${pluginId} has an incomplete or invalid full audit definition.`);
  }
  return {
    id: value.id,
    area: value.area,
    title: value.title,
    userPromise: value.userPromise,
    severity: value.severity,
    releaseBlocking: value.releaseBlocking,
    expected: value.expected,
    evidence: [...value.evidence],
    evidencePolicy: { mode: value.evidencePolicy.mode, rationale: value.evidencePolicy.rationale },
    ...(typeof value.manual === 'boolean' ? { manual: value.manual } : {}),
  };
}

export function validatePortalPluginRegistryDocument(document, options) {
  const { coreDefinitions, projectIds, resolveEntrySpec } = options;
  if (document?.schemaVersion !== 1 || !Array.isArray(document.plugins)) {
    throw new Error('Installed test plugin registry has an unsupported schema.');
  }
  const coreIds = new Set(coreDefinitions.map(({ id }) => id));
  const seenPluginIds = new Set();
  const seenAuditIds = new Set();
  return document.plugins.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !PLUGIN_ID_PATTERN.test(value.id ?? '')) {
      throw new Error('Installed test plugin has an invalid ID.');
    }
    if (seenPluginIds.has(value.id)) throw new Error(`Duplicate installed test plugin: ${value.id}.`);
    seenPluginIds.add(value.id);
    if (!nonEmptyString(value.name, 120) || !nonEmptyString(value.description, 500)) {
      throw new Error(`Installed test plugin ${value.id} has invalid descriptive metadata.`);
    }
    if (!Array.isArray(value.auditDefinitions) || !Array.isArray(value.entrySpecs) || !Array.isArray(value.supportedProjects)) {
      throw new Error(`Installed test plugin ${value.id} has incomplete allowlists.`);
    }
    const auditDefinitions = value.auditDefinitions.map((definition) => {
      const validated = validatedAuditDefinition(definition, value.id);
      if (seenAuditIds.has(validated.id)) throw new Error(`Duplicate plugin audit ID: ${validated.id}.`);
      seenAuditIds.add(validated.id);
      const core = coreDefinitions.find(({ id }) => id === validated.id);
      if (coreIds.has(validated.id) && core
        && (core.area !== validated.area || core.title !== validated.title || core.manual !== validated.manual)) {
        throw new Error(`Plugin ${value.id} conflicts with core audit ${validated.id}.`);
      }
      return validated;
    });
    const entrySpecs = [...new Set(value.entrySpecs)].map((spec) => {
      if (typeof spec !== 'string'
        || spec.includes('..')
        || !/^(?:tests|plugins\/[a-z0-9][a-z0-9-]{1,63})\/[a-zA-Z0-9._/-]+\.spec\.ts$/.test(spec)
        || !resolveEntrySpec(spec)) {
        throw new Error(`Installed test plugin ${value.id} has an unsafe test entry.`);
      }
      return spec;
    });
    const supportedProjects = [...new Set(value.supportedProjects)];
    if (supportedProjects.length === 0 || supportedProjects.some((project) => !projectIds.has(project))) {
      throw new Error(`Installed test plugin ${value.id} has an invalid project allowlist.`);
    }
    return {
      id: value.id,
      version: typeof value.version === 'string' ? value.version.slice(0, 40) : null,
      name: value.name,
      description: value.description,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
      auditDefinitions,
      entrySpecs,
      supportedProjects,
    };
  });
}

export function mergePortalCatalog(coreDefinitions, installedPlugins) {
  const definitions = new Map(coreDefinitions.map((definition) => [definition.id, { ...definition }]));
  for (const plugin of installedPlugins) {
    for (const definition of plugin.auditDefinitions) {
      const current = definitions.get(definition.id);
      if (current && (current.area !== definition.area || current.title !== definition.title || current.manual !== definition.manual)) {
        throw new Error(`Plugin ${plugin.id} conflicts with core audit ${definition.id}.`);
      }
      if (!current) definitions.set(definition.id, { ...definition, evidence: [...definition.evidence] });
    }
  }
  return [...definitions.values()];
}
