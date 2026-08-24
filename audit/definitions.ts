import { readFileSync } from 'node:fs';
import { AUDIT_CATALOG } from './catalog.js';
import {
  auditDefinitionsEqual,
  cloneAuditDefinition,
  validatePluginRegistryDocument,
  type PluginRegistry,
} from './plugins.js';
import type { AuditDefinition } from './types.js';

export function mergeAuditDefinitionCatalog(
  coreDefinitions: readonly AuditDefinition[],
  registry: PluginRegistry,
): AuditDefinition[] {
  const definitions = new Map(coreDefinitions.map((definition) => [definition.id, cloneAuditDefinition(definition)]));
  for (const plugin of registry.plugins) {
    for (const definition of plugin.auditDefinitions) {
      const current = definitions.get(definition.id);
      if (current && !auditDefinitionsEqual(current, definition)) {
        throw new Error(`Plugin ${plugin.id} changes canonical metadata for ${definition.id}.`);
      }
      if (!current) definitions.set(definition.id, cloneAuditDefinition(definition));
    }
  }
  return [...definitions.values()];
}

const registryDocument = JSON.parse(
  readFileSync(new URL('./plugins.generated.json', import.meta.url), 'utf8'),
) as unknown;

export const INSTALLED_PLUGIN_REGISTRY = validatePluginRegistryDocument(registryDocument);
export const ALL_AUDIT_CATALOG = mergeAuditDefinitionCatalog(AUDIT_CATALOG, INSTALLED_PLUGIN_REGISTRY);
export const ALL_AUDIT_BY_ID = new Map(ALL_AUDIT_CATALOG.map((definition) => [definition.id, definition]));
