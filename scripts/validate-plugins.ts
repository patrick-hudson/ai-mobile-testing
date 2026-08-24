import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AUDIT_CATALOG } from '../audit/catalog.js';
import {
  GENERATED_PLUGIN_REGISTRY_PATH,
  createPluginRegistry,
  discoverInstalledPlugins,
} from '../audit/plugins.js';

const repositoryRoot = path.resolve(process.cwd());
const plugins = discoverInstalledPlugins(repositoryRoot, { includeDisabled: true, requireEntryFiles: true });
const registry = createPluginRegistry(plugins);
const destination = path.join(repositoryRoot, GENERATED_PLUGIN_REGISTRY_PATH);
const temporary = `${destination}.tmp`;
const supportedArguments = new Set(['--check']);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));
if (unknownArguments.length > 0) throw new Error(`Unknown plugin-validator arguments: ${unknownArguments.join(', ')}.`);
const checkOnly = process.argv.includes('--check');

const installedAuditIds = new Set(registry.plugins.flatMap((plugin) => plugin.auditDefinitions.map(({ id }) => id)));
const missingCatalogAudits = AUDIT_CATALOG.map(({ id }) => id).filter((id) => !installedAuditIds.has(id));
if (missingCatalogAudits.length > 0) {
  throw new Error(`Enabled plugins do not own these core audits: ${missingCatalogAudits.join(', ')}.`);
}

function findCoreSpecs(directory: string, prefix = 'tests'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return findCoreSpecs(absolute, relative);
    return entry.isFile() && entry.name.endsWith('.spec.ts') ? [relative] : [];
  });
}

const allowlistedEntries = new Set(registry.plugins.flatMap((plugin) => plugin.entrySpecs));
const missingCoreSpecs = findCoreSpecs(path.join(repositoryRoot, 'tests')).filter((entry) => !allowlistedEntries.has(entry));
if (missingCoreSpecs.length > 0) {
  throw new Error(`Enabled plugins do not expose these core test specs: ${missingCoreSpecs.join(', ')}.`);
}

const serialized = `${JSON.stringify(registry, null, 2)}\n`;
if (checkOnly) {
  const current = existsSync(destination) ? readFileSync(destination, 'utf8') : null;
  if (current !== serialized) {
    throw new Error(`${path.relative(repositoryRoot, destination)} is missing or stale. Run the validator without --check and commit the result.`);
  }
} else {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, destination);
}

const enabledCount = plugins.filter(({ manifest }) => manifest.enabled).length;
const disabledCount = plugins.length - enabledCount;
const auditCount = registry.plugins.reduce((total, plugin) => total + plugin.auditDefinitions.length, 0);
const entryCount = new Set(registry.plugins.flatMap((plugin) => plugin.entrySpecs)).size;

process.stdout.write(
  `Validated ${enabledCount} installed plugin(s), ${disabledCount} disabled template(s), ${auditCount} audit definitions, and ${entryCount} allowlisted spec files.\n` +
  `${checkOnly ? 'Confirmed' : 'Wrote'} ${path.relative(repositoryRoot, destination)}${checkOnly ? ' is current' : ''}.\n`,
);
