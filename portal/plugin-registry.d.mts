import type { PluginRegistryEntry } from '../audit/plugins.js';
import type { AuditDefinition } from '../audit/types.js';

export interface PortalPluginRegistryOptions {
  coreDefinitions: readonly AuditDefinition[];
  projectIds: ReadonlySet<string>;
  resolveEntrySpec: (entrySpec: string) => boolean;
}

export function validatePortalPluginRegistryDocument(
  document: unknown,
  options: PortalPluginRegistryOptions,
): PluginRegistryEntry[];

export function mergePortalCatalog(
  coreDefinitions: readonly AuditDefinition[],
  installedPlugins: readonly PluginRegistryEntry[],
): AuditDefinition[];
