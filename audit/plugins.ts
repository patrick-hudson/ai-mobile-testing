import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { AUDIT_BY_ID } from './catalog.js';
import { AUDIT_ID_PATTERN } from './audit-id.js';
import { assertEvidencePolicy, validateDefinitionEvidencePolicy } from './evidence-policy.js';
import { LOCAL_AUDIT_TARGETS } from './targets.js';
import {
  PAGE_AUDIT_ENTRY_SPEC,
  PAGE_AUDIT_FAMILY,
  pageAuditFamilyMembers,
} from './page-audit-family.js';
import { REPRESENTATIVE_A11Y_ROUTES, REPRESENTATIVE_PERFORMANCE_ROUTES } from './routes.js';
import type { AuditApplicability, AuditArea, AuditDefinition, AuditRunMode } from './types.js';
import { applicableTargetIds } from '../shared/target-applicability.mjs';

export const PLUGIN_SCHEMA_VERSION = 1 as const;
export const PLUGIN_MANIFEST_NAME = 'plugin.json';
export const GENERATED_PLUGIN_REGISTRY_PATH = 'audit/plugins.generated.json';

export const CANONICAL_PROJECTS = LOCAL_AUDIT_TARGETS.map(({ id }) => id);

const AUDIT_AREAS = [
  'environment',
  'routes',
  'shell',
  'navigation',
  'responsive',
  'theme',
  'search',
  'homepage',
  'crisis',
  'content',
  'calculators',
  'sows',
  'meetings',
  'accessibility',
  'reliability',
  'performance',
  'seo',
] as const satisfies readonly AuditArea[];

const EVIDENCE_TYPES = [
  'video',
  'screenshot',
  'trace',
  'json',
  'axe',
  'network',
  'lighthouse',
] as const satisfies readonly AuditDefinition['evidence'][number][];

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const SINGLE_SITE_CLASSIFICATIONS = ['standalone-compatible', 'comparison-only', 'standalone-required'] as const;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TAG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CORE_TEST_PATTERN = /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/;
const PLUGIN_TEST_PATTERN = /^plugins\/[a-zA-Z0-9_-]+\/tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/;

type CanonicalProject = (typeof LOCAL_AUDIT_TARGETS)[number]['id'];

export interface PluginAuditCase {
  caseId: string;
  auditId: string;
  entrySpec: string;
  applicability: AuditApplicability;
  supportedProjects: CanonicalProject[];
  supportedModes: AuditRunMode[];
  oracleVariants: {
    comparative?: string;
    singleSite?: string;
  };
}

export interface CoreAuditReference {
  id: string;
  source: 'core';
}

export type PluginAuditDeclaration = CoreAuditReference | AuditDefinition;

export interface PluginManifest {
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  auditDefinitions: PluginAuditDeclaration[];
  auditFamilies: PluginAuditFamily[];
  entrySpecs: string[];
  supportedProjects: CanonicalProject[];
}

export type PluginAuditFamily = typeof PAGE_AUDIT_FAMILY;

const PLUGIN_AUDIT_FAMILIES = new Set<PluginAuditFamily>([PAGE_AUDIT_FAMILY]);

export interface InstalledPlugin {
  directory: string;
  manifestPath: string;
  manifest: PluginManifest;
  resolvedAuditDefinitions: AuditDefinition[];
  resolvedAuditCases: PluginAuditCase[];
}

export type PluginRegistryAuditDefinition = AuditDefinition;

export interface PluginRegistryEntry {
  id: string;
  version: string;
  name: string;
  description: string;
  tags: string[];
  auditDefinitions: PluginRegistryAuditDefinition[];
  entrySpecs: string[];
  supportedProjects: CanonicalProject[];
  auditCases: PluginAuditCase[];
}

export interface PluginRegistry {
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  plugins: PluginRegistryEntry[];
}

export function cloneAuditDefinition(definition: AuditDefinition): AuditDefinition {
  return {
    ...definition,
    evidence: [...definition.evidence],
    evidencePolicy: { ...definition.evidencePolicy },
    ...(definition.standaloneOracle ? { standaloneOracle: { ...definition.standaloneOracle } } : {}),
  };
}

export function auditDefinitionsEqual(left: AuditDefinition, right: AuditDefinition): boolean {
  return left.id === right.id
    && left.area === right.area
    && left.title === right.title
    && left.userPromise === right.userPromise
    && left.severity === right.severity
    && left.releaseBlocking === right.releaseBlocking
    && left.expected === right.expected
    && left.evidencePolicy.mode === right.evidencePolicy.mode
    && left.evidencePolicy.rationale === right.evidencePolicy.rationale
    && left.singleSiteClassification === right.singleSiteClassification
    && left.standaloneOracle?.id === right.standaloneOracle?.id
    && left.standaloneOracle?.expected === right.standaloneOracle?.expected
    && left.manual === right.manual
    && left.evidence.length === right.evidence.length
    && left.evidence.every((value, index) => value === right.evidence[index]);
}

export interface DiscoverPluginOptions {
  includeDisabled?: boolean;
  requireEntryFiles?: boolean;
}

export class PluginValidationError extends Error {
  readonly manifestPath: string;
  readonly issues: string[];

  constructor(manifestPath: string, issues: string[]) {
    super(`Invalid test plugin ${manifestPath}:\n- ${issues.join('\n- ')}`);
    this.name = 'PluginValidationError';
    this.manifestPath = manifestPath;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function duplicateValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const AUDIT_TEST_HELPERS = new Set(['interactionTest', 'staticTest', 'structuredTest', 'standaloneStaticTest']);
const AUDIT_EVIDENCE_HELPERS = new Set(['interactionEvidence', 'staticEvidence', 'structuredEvidence', 'standaloneStaticEvidence']);

function supportedProjectsForApplicability(applicability: AuditApplicability | CanonicalProject): CanonicalProject[] {
  return applicableTargetIds(applicability, LOCAL_AUDIT_TARGETS) as CanonicalProject[];
}

function caseMetadata(
  definition: AuditDefinition,
  entrySpec: string,
  applicability: AuditApplicability,
  caseVariant?: string,
): Pick<PluginAuditCase, 'caseId' | 'supportedModes' | 'oracleVariants'> {
  const supportedModes: AuditRunMode[] = definition.singleSiteClassification === 'standalone-compatible'
    ? ['comparative', 'single-site']
    : ['comparative'];
  return {
    caseId: `${definition.id}:${entrySpec}:${applicability}${caseVariant ? `:case:${encodeURIComponent(caseVariant)}` : ''}`,
    supportedModes,
    oracleVariants: {
      comparative: `${definition.id}:comparative`,
      ...(supportedModes.includes('single-site') && definition.standaloneOracle
        ? { singleSite: definition.standaloneOracle.id }
        : {}),
    },
  };
}

function standaloneCaseMetadata(
  definition: AuditDefinition,
  entrySpec: string,
  applicability: AuditApplicability,
  oracleVariant: string,
): Pick<PluginAuditCase, 'caseId' | 'supportedModes' | 'oracleVariants'> {
  if (definition.singleSiteClassification === 'comparison-only') {
    throw new Error(`${definition.id} is comparison-only and cannot declare a standalone executable case.`);
  }
  return {
    caseId: `${definition.id}:${entrySpec}:${applicability}:single-site:${oracleVariant}`,
    supportedModes: ['single-site'],
    oracleVariants: { singleSite: oracleVariant },
  };
}

interface AuditFamilyExpansion {
  definitions: AuditDefinition[];
  cases: PluginAuditCase[];
}

function expandAuditFamily(
  family: PluginAuditFamily,
): AuditFamilyExpansion {
  switch (family) {
    case PAGE_AUDIT_FAMILY: {
      const members = pageAuditFamilyMembers();
      return {
        definitions: members.map(({ definition }) => definition),
        cases: members.map(({ definition, applicability }) => ({
          ...caseMetadata(definition, PAGE_AUDIT_ENTRY_SPEC, applicability),
          auditId: definition.id,
          entrySpec: PAGE_AUDIT_ENTRY_SPEC,
          applicability,
          supportedProjects: supportedProjectsForApplicability(applicability),
        })),
      };
    }
  }
}

function callArguments(source: string, openParenthesis: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let start = openParenthesis + 1;
  let depth = 1;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(start, index).trim());
        return { args, end: index + 1 };
      }
    } else if (character === ',' && depth === 1) {
      args.push(source.slice(start, index).trim());
      if (args.length === 2) return { args, end: index + 1 };
      start = index + 1;
    }
  }
  return null;
}

function literalPrefix(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  const quote = trimmed[0];
  if (!['"', "'", '`'].includes(quote ?? '')) return null;
  let output = '';
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (escaped) {
      output += character;
      escaped = false;
    } else if (character === '\\') escaped = true;
    else if (character === quote || (quote === '`' && character === '$' && trimmed[index + 1] === '{')) return output;
    else output += character;
  }
  return null;
}

function auditCasesFromEntrySpec(
  repositoryRoot: string,
  entrySpec: string,
  ownedDefinitions: ReadonlyMap<string, AuditDefinition>,
  issues: string[],
): PluginAuditCase[] {
  const file = path.resolve(repositoryRoot, entrySpec);
  const source = readFileSync(file, 'utf8');
  const cases: PluginAuditCase[] = [];
  const helperPattern = /\b(interactionTest|staticTest|structuredTest|standaloneStaticTest)\s*\(/g;
  for (const match of source.matchAll(helperPattern)) {
    if (!AUDIT_TEST_HELPERS.has(match[1] ?? '')) continue;
    const openParenthesis = (match.index ?? 0) + match[0].lastIndexOf('(');
    const parsed = callArguments(source, openParenthesis);
    if (!parsed) {
      issues.push(`${entrySpec} contains an unterminated ${match[1]} declaration.`);
      continue;
    }
    const title = literalPrefix(parsed.args[0]);
    const auditIds = title ? [...title.matchAll(/\[([A-Z0-9]+(?:-[A-Z0-9]+)+)\]/g)].map((idMatch) => idMatch[1]!) : [];
    const evidence = parsed.args[1] ?? '';
    const evidenceHelper = evidence.match(/^([a-zA-Z]+Evidence)\s*\(/)?.[1] ?? '';
    const standaloneEvidence = evidenceHelper === 'standaloneStaticEvidence';
    const standaloneArguments = standaloneEvidence
      ? evidence.match(/,\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*,?\s*\)\s*$/)
      : null;
    const standardArguments = !standaloneEvidence
      ? evidence.match(/,\s*(['"])([^'"]+)\1(?:\s*,\s*([A-Za-z_$][\w$]*|(['"])([^'"]+)\4))?\s*\)\s*$/)
      : null;
    const applicability = AUDIT_EVIDENCE_HELPERS.has(evidenceHelper)
      ? standaloneEvidence
        ? standaloneArguments?.[2] ?? null
        : standardArguments?.[2] ?? null
      : null;
    const standaloneOracleVariant = standaloneArguments?.[4] ?? null;
    const literalCaseVariant = standardArguments?.[5] ?? null;
    const caseVariantIdentifier = literalCaseVariant ? null : standardArguments?.[3] ?? null;
    let caseVariants: Array<string | undefined> = [undefined];
    if (literalCaseVariant) caseVariants = [literalCaseVariant];
    else if (caseVariantIdentifier) {
      const parameterizedRoutes = entrySpec === 'tests/accessibility.spec.ts' && caseVariantIdentifier === 'candidatePath'
        ? REPRESENTATIVE_A11Y_ROUTES
        : entrySpec === 'tests/performance.spec.ts' && caseVariantIdentifier === 'candidatePath'
          ? REPRESENTATIVE_PERFORMANCE_ROUTES
          : null;
      if (!parameterizedRoutes) {
        issues.push(`${entrySpec} uses unsupported dynamic case variant ${caseVariantIdentifier}; declare reviewed expansion metadata.`);
        continue;
      }
      caseVariants = [...parameterizedRoutes];
    }
    for (const auditId of auditIds.filter((id) => ownedDefinitions.has(id))) {
      if (!applicability) {
        issues.push(`${entrySpec} declares ${auditId} without a literal applicability argument.`);
        continue;
      }
      const projects = supportedProjectsForApplicability(applicability as AuditApplicability);
      if (projects.length === 0) {
        issues.push(`${entrySpec} declares ${auditId} with unknown or zero-project applicability "${applicability}".`);
        continue;
      }
      const definition = ownedDefinitions.get(auditId)!;
      for (const caseVariant of caseVariants) {
        cases.push({
          ...(standaloneEvidence && standaloneOracleVariant
            ? standaloneCaseMetadata(definition, entrySpec, applicability as AuditApplicability, standaloneOracleVariant)
            : caseMetadata(definition, entrySpec, applicability as AuditApplicability, caseVariant)),
          auditId,
          entrySpec,
          applicability: applicability as AuditApplicability,
          supportedProjects: projects,
        });
      }
    }
  }
  return cases;
}

function resolveAuditCases(
  repositoryRoot: string,
  entrySpecs: readonly string[],
  definitions: readonly AuditDefinition[],
  supportedProjects: readonly CanonicalProject[],
  issues: string[],
  additionalCases: readonly PluginAuditCase[] = [],
): PluginAuditCase[] {
  const ownedDefinitions = new Map(definitions.map((definition) => [definition.id, definition]));
  const cases = [
    ...entrySpecs.flatMap((entrySpec) => auditCasesFromEntrySpec(repositoryRoot, entrySpec, ownedDefinitions, issues)),
    ...additionalCases,
  ];
  const caseKeys = cases.map((entry) => JSON.stringify(entry));
  if (duplicateValues(caseKeys).length > 0) {
    issues.push('Executable audit declarations contain duplicate audit/spec/applicability cases.');
  }
  const unique = [...new Map(cases.map((entry) => [JSON.stringify(entry), entry])).values()]
    .sort((left, right) => left.auditId.localeCompare(right.auditId)
      || left.entrySpec.localeCompare(right.entrySpec)
      || left.applicability.localeCompare(right.applicability));
  const pluginProjects = new Set(supportedProjects);
  for (const entry of unique) {
    const outside = entry.supportedProjects.filter((project) => !pluginProjects.has(project));
    if (outside.length > 0) {
      issues.push(`${entry.entrySpec} maps ${entry.auditId} to projects outside the plugin allowlist: ${outside.join(', ')}.`);
    }
  }
  const automated = definitions.filter(({ manual }) => !manual);
  const declared = new Set(unique.map(({ auditId }) => auditId));
  const missing = automated.filter(({ id }) => !declared.has(id)).map(({ id }) => id);
  if (missing.length > 0) issues.push(`Automated audits have no executable test/applicability case: ${missing.join(', ')}.`);
  return unique;
}

function validateEntrySpec(
  entry: unknown,
  directory: string,
  repositoryRoot: string,
  requireEntryFiles: boolean,
  issues: string[],
): entry is string {
  if (!nonEmptyString(entry)) {
    issues.push('Every entrySpecs value must be a non-empty string.');
    return false;
  }
  if (entry.includes('\\') || path.posix.normalize(entry) !== entry || path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
    issues.push(`Entry spec "${entry}" is not a normalized, repository-relative path.`);
    return false;
  }
  if (!CORE_TEST_PATTERN.test(entry) && !PLUGIN_TEST_PATTERN.test(entry)) {
    issues.push(`Entry spec "${entry}" must match tests/**/*.spec.ts or plugins/<id>/tests/**/*.spec.ts.`);
    return false;
  }
  if (entry.startsWith('plugins/') && !entry.startsWith(`plugins/${directory}/tests/`)) {
    issues.push(`Entry spec "${entry}" may not point into another plugin directory.`);
    return false;
  }
  if (!requireEntryFiles) return true;

  const absolute = path.resolve(repositoryRoot, entry);
  if (!isInside(repositoryRoot, absolute)) {
    issues.push(`Entry spec "${entry}" resolves outside the repository.`);
    return false;
  }
  if (!existsSync(absolute)) {
    issues.push(`Entry spec "${entry}" does not exist.`);
    return false;
  }
  const real = realpathSync(absolute);
  if (!isInside(realpathSync(repositoryRoot), real)) {
    issues.push(`Entry spec "${entry}" resolves through a symlink outside the repository.`);
    return false;
  }
  return true;
}

function validateInlineAudit(value: Record<string, unknown>, label: string, issues: string[]): AuditDefinition | null {
  const allowedKeys = new Set([
    'id',
    'area',
    'title',
    'userPromise',
    'severity',
    'releaseBlocking',
    'expected',
    'evidence',
    'evidencePolicy',
    'singleSiteClassification',
    'standaloneOracle',
    'manual',
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) issues.push(`${label} contains unknown keys: ${unknownKeys.join(', ')}.`);

  if (!nonEmptyString(value.id) || !AUDIT_ID_PATTERN.test(value.id)) issues.push(`${label}.id must use uppercase AUDIT-ID form.`);
  if (!AUDIT_AREAS.includes(value.area as AuditArea)) issues.push(`${label}.area is unknown.`);
  if (!nonEmptyString(value.title)) issues.push(`${label}.title must be a non-empty string.`);
  if (!nonEmptyString(value.userPromise)) issues.push(`${label}.userPromise must be a non-empty string.`);
  if (!SEVERITIES.includes(value.severity as (typeof SEVERITIES)[number])) issues.push(`${label}.severity must be P0, P1, P2, or P3.`);
  if (typeof value.releaseBlocking !== 'boolean') issues.push(`${label}.releaseBlocking must be boolean.`);
  if ((value.severity === 'P0' || value.severity === 'P1') && value.releaseBlocking !== true) {
    issues.push(`${label}.releaseBlocking must be true for P0 and P1 audits.`);
  }
  if (!nonEmptyString(value.expected)) issues.push(`${label}.expected must be a non-empty string.`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    issues.push(`${label}.evidence must be a non-empty array.`);
  } else {
    const evidence = value.evidence.filter((item): item is string => typeof item === 'string');
    const unknownEvidence = evidence.filter((item) => !EVIDENCE_TYPES.includes(item as (typeof EVIDENCE_TYPES)[number]));
    if (evidence.length !== value.evidence.length || unknownEvidence.length > 0) {
      issues.push(`${label}.evidence contains unknown values: ${unknownEvidence.join(', ') || 'non-string value'}.`);
    }
    const duplicates = duplicateValues(evidence);
    if (duplicates.length > 0) issues.push(`${label}.evidence contains duplicates: ${duplicates.join(', ')}.`);
  }
  if (value.manual !== undefined && typeof value.manual !== 'boolean') issues.push(`${label}.manual must be boolean when provided.`);
  if (!SINGLE_SITE_CLASSIFICATIONS.includes(value.singleSiteClassification as (typeof SINGLE_SITE_CLASSIFICATIONS)[number])) {
    issues.push(`${label}.singleSiteClassification is invalid.`);
  }
  let standaloneOracle: AuditDefinition['standaloneOracle'];
  if (value.standaloneOracle !== undefined) {
    if (!isRecord(value.standaloneOracle)
      || !nonEmptyString(value.standaloneOracle.id)
      || !nonEmptyString(value.standaloneOracle.expected)) {
      issues.push(`${label}.standaloneOracle must contain non-empty id and expected strings.`);
    } else {
      standaloneOracle = {
        id: value.standaloneOracle.id,
        expected: value.standaloneOracle.expected,
      };
    }
  }
  if (value.singleSiteClassification === 'standalone-compatible' && !standaloneOracle) {
    issues.push(`${label}.standaloneOracle is required for standalone-compatible definitions.`);
  }
  if (value.singleSiteClassification !== 'standalone-compatible' && standaloneOracle) {
    issues.push(`${label}.standaloneOracle is allowed only for standalone-compatible definitions.`);
  }
  let evidencePolicy: AuditDefinition['evidencePolicy'] | null = null;
  try {
    evidencePolicy = assertEvidencePolicy(value.evidencePolicy, `${label}.evidencePolicy`);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const before = issues.length;
  if (before > 0 && issues.some((issue) => issue.startsWith(label))) return null;
  const definition: AuditDefinition = {
    id: value.id as string,
    area: value.area as AuditArea,
    title: value.title as string,
    userPromise: value.userPromise as string,
    severity: value.severity as AuditDefinition['severity'],
    releaseBlocking: value.releaseBlocking as boolean,
    expected: value.expected as string,
    evidence: value.evidence as AuditDefinition['evidence'],
    evidencePolicy: evidencePolicy as AuditDefinition['evidencePolicy'],
    singleSiteClassification: value.singleSiteClassification as AuditDefinition['singleSiteClassification'],
  };
  if (standaloneOracle) definition.standaloneOracle = standaloneOracle;
  if (typeof value.manual === 'boolean') definition.manual = value.manual;
  try {
    validateDefinitionEvidencePolicy(definition, label);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return null;
  }
  return definition;
}

export function assertAuditDefinition(value: unknown, label = 'audit definition'): AuditDefinition {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const issues: string[] = [];
  const definition = validateInlineAudit(value, label, issues);
  if (!definition || issues.length > 0) throw new Error(`${label} is invalid:\n- ${issues.join('\n- ')}`);
  return cloneAuditDefinition(definition);
}

export function validatePluginRegistryDocument(raw: unknown): PluginRegistry {
  if (!isRecord(raw) || raw.schemaVersion !== PLUGIN_SCHEMA_VERSION || !Array.isArray(raw.plugins)) {
    throw new Error(`Generated plugin registry must use schemaVersion ${PLUGIN_SCHEMA_VERSION} and contain a plugins array.`);
  }
  const pluginIds = new Set<string>();
  const auditIds = new Set<string>();
  const plugins = raw.plugins.map((value, pluginIndex): PluginRegistryEntry => {
    const label = `plugins[${pluginIndex}]`;
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    if (!nonEmptyString(value.id) || !PLUGIN_ID_PATTERN.test(value.id) || pluginIds.has(value.id)) {
      throw new Error(`${label}.id must be a unique lowercase kebab-case plugin ID.`);
    }
    pluginIds.add(value.id);
    if (!nonEmptyString(value.version) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
      throw new Error(`${label}.version must use semantic version syntax.`);
    }
    if (!nonEmptyString(value.name) || !nonEmptyString(value.description)) {
      throw new Error(`${label} must retain its name and description.`);
    }
    const tags = Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string' && TAG_PATTERN.test(tag))
      ? [...value.tags]
      : null;
    if (!tags || duplicateValues(tags).length > 0) throw new Error(`${label}.tags is invalid.`);
    if (!Array.isArray(value.auditDefinitions) || value.auditDefinitions.length === 0) {
      throw new Error(`${label}.auditDefinitions must be a non-empty array.`);
    }
    const auditDefinitions = value.auditDefinitions.map((definition, definitionIndex) => {
      const resolved = assertAuditDefinition(definition, `${label}.auditDefinitions[${definitionIndex}]`);
      if ((resolved.severity === 'P0' || resolved.severity === 'P1') && !resolved.releaseBlocking) {
        throw new Error(`${label}.auditDefinitions[${definitionIndex}] cannot publish a non-blocking ${resolved.severity} audit.`);
      }
      if (auditIds.has(resolved.id)) throw new Error(`Duplicate generated audit definition: ${resolved.id}.`);
      auditIds.add(resolved.id);
      return resolved;
    });
    const entrySpecs = Array.isArray(value.entrySpecs) && value.entrySpecs.every((entry) =>
      typeof entry === 'string' && (CORE_TEST_PATTERN.test(entry) || PLUGIN_TEST_PATTERN.test(entry)))
      ? [...value.entrySpecs]
      : null;
    if (!entrySpecs || entrySpecs.length === 0 || duplicateValues(entrySpecs).length > 0) {
      throw new Error(`${label}.entrySpecs is invalid.`);
    }
    const supportedProjects = Array.isArray(value.supportedProjects) && value.supportedProjects.every((project) =>
      typeof project === 'string' && CANONICAL_PROJECTS.includes(project as CanonicalProject))
      ? [...value.supportedProjects] as CanonicalProject[]
      : null;
    if (!supportedProjects || supportedProjects.length === 0 || duplicateValues(supportedProjects).length > 0) {
      throw new Error(`${label}.supportedProjects is invalid.`);
    }
    if (!Array.isArray(value.auditCases) || (value.auditCases.length === 0 && auditDefinitions.some(({ manual }) => !manual))) {
      throw new Error(`${label}.auditCases must cover every automated audit.`);
    }
    const rawCaseKeys = value.auditCases.map((rawCase) => isRecord(rawCase)
      ? String(rawCase.caseId)
      : JSON.stringify(rawCase));
    const duplicateCaseKeys = duplicateValues(rawCaseKeys);
    if (duplicateCaseKeys.length > 0) {
      throw new Error(`${label}.auditCases contains duplicate executable cases.`);
    }
    const definitionIds = new Set(auditDefinitions.map(({ id }) => id));
    const auditCases = value.auditCases.map((rawCase, caseIndex): PluginAuditCase => {
      const caseLabel = `${label}.auditCases[${caseIndex}]`;
      if (!isRecord(rawCase) || !nonEmptyString(rawCase.auditId) || !definitionIds.has(rawCase.auditId)) {
        throw new Error(`${caseLabel}.auditId must reference an audit owned by this plugin.`);
      }
      if (!nonEmptyString(rawCase.entrySpec) || !entrySpecs.includes(rawCase.entrySpec)) {
        throw new Error(`${caseLabel}.entrySpec must reference this plugin's executable allowlist.`);
      }
      if (!nonEmptyString(rawCase.applicability)) throw new Error(`${caseLabel}.applicability is invalid.`);
      if (!nonEmptyString(rawCase.caseId)) throw new Error(`${caseLabel}.caseId must be a stable non-empty string.`);
      if (!Array.isArray(rawCase.supportedModes)
        || rawCase.supportedModes.length === 0
        || rawCase.supportedModes.some((mode) => mode !== 'comparative' && mode !== 'single-site')
        || duplicateValues(rawCase.supportedModes as string[]).length > 0) {
        throw new Error(`${caseLabel}.supportedModes is invalid.`);
      }
      if (!isRecord(rawCase.oracleVariants)) throw new Error(`${caseLabel}.oracleVariants must be an object.`);
      const supportsComparative = rawCase.supportedModes.includes('comparative');
      const supportsSingleSite = rawCase.supportedModes.includes('single-site');
      if (supportsComparative !== nonEmptyString(rawCase.oracleVariants.comparative)) {
        throw new Error(`${caseLabel}.comparative Product Oracle variant must match supportedModes.`);
      }
      if (supportsSingleSite !== nonEmptyString(rawCase.oracleVariants.singleSite)) {
        throw new Error(`${caseLabel}.singleSite Product Oracle variant must match supportedModes.`);
      }
      const definition = auditDefinitions.find(({ id }) => id === rawCase.auditId)!;
      if (supportsSingleSite && definition.singleSiteClassification === 'comparison-only') {
        throw new Error(`${caseLabel} cannot support Single-site mode for a comparison-only definition.`);
      }
      if (supportsSingleSite
        && definition.singleSiteClassification === 'standalone-compatible'
        && rawCase.oracleVariants.singleSite !== definition.standaloneOracle?.id) {
        throw new Error(`${caseLabel}.singleSite Product Oracle variant does not match its definition.`);
      }
      const expectedProjects = supportedProjectsForApplicability(rawCase.applicability as AuditApplicability);
      if (expectedProjects.length === 0
        || !Array.isArray(rawCase.supportedProjects)
        || rawCase.supportedProjects.some((project) => typeof project !== 'string' || !CANONICAL_PROJECTS.includes(project as CanonicalProject))
        || JSON.stringify(rawCase.supportedProjects) !== JSON.stringify(expectedProjects)) {
        throw new Error(`${caseLabel}.supportedProjects does not match its declared applicability.`);
      }
      return {
        caseId: rawCase.caseId,
        auditId: rawCase.auditId,
        entrySpec: rawCase.entrySpec,
        applicability: rawCase.applicability as AuditApplicability,
        supportedProjects: expectedProjects,
        supportedModes: [...rawCase.supportedModes] as AuditRunMode[],
        oracleVariants: {
          ...(supportsComparative ? { comparative: rawCase.oracleVariants.comparative as string } : {}),
          ...(supportsSingleSite ? { singleSite: rawCase.oracleVariants.singleSite as string } : {}),
        },
      };
    });
    const declaredCases = new Set(auditCases.map(({ auditId }) => auditId));
    const missingCases = auditDefinitions.filter(({ id, manual }) => !manual && !declaredCases.has(id)).map(({ id }) => id);
    if (missingCases.length > 0) throw new Error(`${label}.auditCases omit automated audits: ${missingCases.join(', ')}.`);
    const singleSiteCases = new Set(auditCases
      .filter(({ supportedModes }) => supportedModes.includes('single-site'))
      .map(({ auditId }) => auditId));
    const missingSingleSiteCases = auditDefinitions
      .filter(({ id, manual, singleSiteClassification }) => !manual
        && singleSiteClassification === 'standalone-compatible'
        && !singleSiteCases.has(id))
      .map(({ id }) => id);
    if (missingSingleSiteCases.length > 0) {
      throw new Error(`${label}.auditCases omit Single-site cases for standalone-compatible audits: ${missingSingleSiteCases.join(', ')}.`);
    }
    return {
      id: value.id,
      version: value.version,
      name: value.name,
      description: value.description,
      tags,
      auditDefinitions,
      entrySpecs,
      supportedProjects,
      auditCases,
    };
  });
  const routePlugin = plugins.find(({ id }) => id === 'platform-routes-content');
  if (routePlugin) {
    const members = pageAuditFamilyMembers();
    const expectedDefinitions = members.map(({ definition }) => definition).sort((left, right) => left.id.localeCompare(right.id));
    const actualDefinitions = routePlugin.auditDefinitions.filter(({ id }) => id.startsWith('PAGE-')).sort((left, right) => left.id.localeCompare(right.id));
    if (actualDefinitions.length !== expectedDefinitions.length
      || actualDefinitions.some((definition, index) => !auditDefinitionsEqual(definition, expectedDefinitions[index]!))) {
      throw new Error('platform-routes-content PAGE definitions must equal the reviewed candidate-html-routes family exactly.');
    }
    const expectedCases = members
      .map(({ definition, applicability }) => {
        const metadata = caseMetadata(definition, PAGE_AUDIT_ENTRY_SPEC, applicability);
        return JSON.stringify([
          metadata.caseId,
          definition.id,
          PAGE_AUDIT_ENTRY_SPEC,
          applicability,
          supportedProjectsForApplicability(applicability),
          metadata.supportedModes,
          metadata.oracleVariants,
        ]);
      })
      .sort();
    const actualCases = routePlugin.auditCases
      .filter(({ auditId }) => auditId.startsWith('PAGE-'))
      .map((auditCase) => JSON.stringify([
        auditCase.caseId,
        auditCase.auditId,
        auditCase.entrySpec,
        auditCase.applicability,
        auditCase.supportedProjects,
        auditCase.supportedModes,
        auditCase.oracleVariants,
      ]))
      .sort();
    if (JSON.stringify(actualCases) !== JSON.stringify(expectedCases)) {
      throw new Error('platform-routes-content PAGE cases must contain exactly one route-specific executable case per reviewed family member.');
    }
  }
  return { schemaVersion: PLUGIN_SCHEMA_VERSION, plugins };
}

function resolveAuditDeclaration(value: unknown, index: number, issues: string[]): AuditDefinition | null {
  const label = `auditDefinitions[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${label} must be an object.`);
    return null;
  }
  if (value.source === 'core') {
    const unknownKeys = Object.keys(value).filter((key) => key !== 'id' && key !== 'source');
    if (unknownKeys.length > 0) issues.push(`${label} core reference contains unknown keys: ${unknownKeys.join(', ')}.`);
    if (!nonEmptyString(value.id) || !AUDIT_ID_PATTERN.test(value.id)) {
      issues.push(`${label}.id must use uppercase AUDIT-ID form.`);
      return null;
    }
    const definition = AUDIT_BY_ID.get(value.id);
    if (!definition) {
      issues.push(`${label} references unknown core audit "${value.id}".`);
      return null;
    }
    return definition;
  }
  if ('source' in value) {
    issues.push(`${label}.source must be "core" when provided.`);
    return null;
  }
  return validateInlineAudit(value, label, issues);
}

export function validatePluginManifest(
  raw: unknown,
  manifestPath: string,
  repositoryRoot: string,
  options: DiscoverPluginOptions = {},
): InstalledPlugin {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new PluginValidationError(manifestPath, ['Manifest root must be a JSON object.']);
  const directory = path.basename(path.dirname(manifestPath));
  const allowedKeys = new Set([
    'schemaVersion',
    'id',
    'version',
    'name',
    'description',
    'enabled',
    'tags',
    'auditDefinitions',
    'auditFamilies',
    'entrySpecs',
    'supportedProjects',
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) issues.push(`Unknown manifest keys: ${unknownKeys.join(', ')}.`);

  if (raw.schemaVersion !== PLUGIN_SCHEMA_VERSION) issues.push(`schemaVersion must be ${PLUGIN_SCHEMA_VERSION}.`);
  if (!nonEmptyString(raw.id) || !PLUGIN_ID_PATTERN.test(raw.id)) issues.push('id must be lowercase kebab-case.');
  if (!nonEmptyString(raw.version) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)) issues.push('version must be semantic version syntax.');
  if (!nonEmptyString(raw.name)) issues.push('name must be a non-empty string.');
  if (!nonEmptyString(raw.description)) issues.push('description must be a non-empty string.');
  if (typeof raw.enabled !== 'boolean') issues.push('enabled must be boolean.');
  if (raw.enabled === true && nonEmptyString(raw.id) && directory !== raw.id) issues.push(`Enabled plugin directory "${directory}" must match id "${raw.id}".`);

  const tags = Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === 'string') : [];
  if (!Array.isArray(raw.tags) || tags.length !== raw.tags.length) issues.push('tags must be an array of strings.');
  for (const tag of tags) if (!TAG_PATTERN.test(tag)) issues.push(`Tag "${tag}" must be lowercase kebab-case.`);
  const duplicateTags = duplicateValues(tags);
  if (duplicateTags.length > 0) issues.push(`Duplicate tags: ${duplicateTags.join(', ')}.`);

  const declarationValues = Array.isArray(raw.auditDefinitions) ? raw.auditDefinitions : [];
  if (!Array.isArray(raw.auditDefinitions) || declarationValues.length === 0) issues.push('auditDefinitions must be a non-empty array.');
  const declaredAuditDefinitions = declarationValues
    .map((declaration, index) => resolveAuditDeclaration(declaration, index, issues))
    .filter((definition): definition is AuditDefinition => definition !== null);
  const familyValues = raw.auditFamilies === undefined ? [] : raw.auditFamilies;
  const auditFamilies = Array.isArray(familyValues)
    ? familyValues.filter((family): family is PluginAuditFamily => (
        typeof family === 'string' && PLUGIN_AUDIT_FAMILIES.has(family as PluginAuditFamily)
      ))
    : [];
  if (!Array.isArray(familyValues) || auditFamilies.length !== familyValues.length) {
    issues.push('auditFamilies must contain only supported generated audit-family IDs.');
  }
  const duplicateFamilies = duplicateValues(auditFamilies);
  if (duplicateFamilies.length > 0) issues.push(`Duplicate audit families: ${duplicateFamilies.join(', ')}.`);
  const familyExpansions = auditFamilies.map((family) => expandAuditFamily(family));
  const familyAuditDefinitions = familyExpansions.flatMap(({ definitions }) => definitions);
  const resolvedAuditDefinitions = [...declaredAuditDefinitions, ...familyAuditDefinitions];
  const duplicateAudits = duplicateValues(resolvedAuditDefinitions.map(({ id }) => id));
  if (duplicateAudits.length > 0) issues.push(`Duplicate audit definitions: ${duplicateAudits.join(', ')}.`);

  const entryValues = Array.isArray(raw.entrySpecs) ? raw.entrySpecs : [];
  if (!Array.isArray(raw.entrySpecs) || entryValues.length === 0) issues.push('entrySpecs must be a non-empty array.');
  const entrySpecs = entryValues.filter((entry) => validateEntrySpec(
    entry,
    directory,
    repositoryRoot,
    options.requireEntryFiles ?? true,
    issues,
  ));
  const duplicateEntries = duplicateValues(entrySpecs);
  if (duplicateEntries.length > 0) issues.push(`Duplicate entry specs: ${duplicateEntries.join(', ')}.`);
  if (auditFamilies.includes(PAGE_AUDIT_FAMILY) && !entrySpecs.includes(PAGE_AUDIT_ENTRY_SPEC)) {
    issues.push(`${PAGE_AUDIT_FAMILY} requires ${PAGE_AUDIT_ENTRY_SPEC} in entrySpecs.`);
  }

  const projectValues = Array.isArray(raw.supportedProjects) ? raw.supportedProjects : [];
  const supportedProjects = projectValues.filter((item): item is CanonicalProject =>
    typeof item === 'string' && CANONICAL_PROJECTS.includes(item as CanonicalProject),
  );
  const unknownProjects = projectValues.filter((item) => typeof item !== 'string' || !CANONICAL_PROJECTS.includes(item as CanonicalProject));
  if (!Array.isArray(raw.supportedProjects) || projectValues.length === 0) issues.push('supportedProjects must be a non-empty array.');
  if (unknownProjects.length > 0) issues.push(`Unknown supported projects: ${unknownProjects.map(String).join(', ')}.`);
  const duplicateProjects = duplicateValues(supportedProjects);
  if (duplicateProjects.length > 0) issues.push(`Duplicate supported projects: ${duplicateProjects.join(', ')}.`);

  const resolvedAuditCases = options.requireEntryFiles === false
    ? []
    : resolveAuditCases(
        repositoryRoot,
        entrySpecs,
        resolvedAuditDefinitions,
        supportedProjects,
        issues,
        familyExpansions.flatMap(({ cases }) => cases),
      );

  if (issues.length > 0) throw new PluginValidationError(manifestPath, issues);
  return {
    directory,
    manifestPath,
    manifest: {
      schemaVersion: PLUGIN_SCHEMA_VERSION,
      id: raw.id as string,
      version: raw.version as string,
      name: raw.name as string,
      description: raw.description as string,
      enabled: raw.enabled as boolean,
      tags,
      auditDefinitions: declarationValues as PluginAuditDeclaration[],
      auditFamilies,
      entrySpecs,
      supportedProjects,
    },
    resolvedAuditDefinitions,
    resolvedAuditCases,
  };
}

export function discoverInstalledPlugins(
  repositoryRoot = process.cwd(),
  options: DiscoverPluginOptions = {},
): InstalledPlugin[] {
  const root = path.resolve(repositoryRoot);
  const pluginRoot = path.join(root, 'plugins');
  if (!existsSync(pluginRoot)) return [];

  const plugins = readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginRoot, entry.name, PLUGIN_MANIFEST_NAME))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new PluginValidationError(path.relative(root, manifestPath), [`Manifest is not valid JSON: ${detail}`]);
      }
      return validatePluginManifest(raw, path.relative(root, manifestPath), root, options);
    })
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));

  const pluginIds = plugins.map(({ manifest }) => manifest.id);
  const duplicatePluginIds = duplicateValues(pluginIds);
  if (duplicatePluginIds.length > 0) throw new PluginValidationError('plugins/', [`Duplicate plugin ids: ${duplicatePluginIds.join(', ')}.`]);

  const enabled = plugins.filter(({ manifest }) => manifest.enabled);
  const auditOwners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const plugin of enabled) {
    for (const definition of plugin.resolvedAuditDefinitions) {
      const owner = auditOwners.get(definition.id);
      if (owner) conflicts.push(`Audit ${definition.id} is declared by both ${owner} and ${plugin.manifest.id}.`);
      else auditOwners.set(definition.id, plugin.manifest.id);
    }
  }
  if (conflicts.length > 0) throw new PluginValidationError('plugins/', conflicts);
  return options.includeDisabled ? plugins : enabled;
}

export function createPluginRegistry(plugins: readonly InstalledPlugin[]): PluginRegistry {
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    plugins: plugins
      .filter(({ manifest }) => manifest.enabled)
      .map(({ manifest, resolvedAuditDefinitions, resolvedAuditCases }) => ({
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        tags: [...manifest.tags],
        auditDefinitions: resolvedAuditDefinitions.map(cloneAuditDefinition),
        entrySpecs: [...manifest.entrySpecs],
        supportedProjects: [...manifest.supportedProjects],
        auditCases: resolvedAuditCases.map((entry) => ({
          ...entry,
          supportedProjects: [...entry.supportedProjects],
          supportedModes: [...entry.supportedModes],
          oracleVariants: { ...entry.oracleVariants },
        })),
      })),
  };
}

export function installedPluginRegistry(repositoryRoot = process.cwd()): PluginRegistry {
  return createPluginRegistry(discoverInstalledPlugins(repositoryRoot));
}

export function pluginEntryAllowlist(
  registry: PluginRegistry,
  selectedPluginIds?: readonly string[],
): string[] {
  const requested = selectedPluginIds ? new Set(selectedPluginIds) : null;
  if (requested) {
    const installed = new Set(registry.plugins.map(({ id }) => id));
    const unknown = [...requested].filter((id) => !installed.has(id));
    if (unknown.length > 0) throw new Error(`Unknown or disabled plugin ids: ${unknown.join(', ')}.`);
  }
  return [...new Set(registry.plugins
    .filter(({ id }) => requested === null || requested.has(id))
    .flatMap(({ entrySpecs }) => entrySpecs))];
}
