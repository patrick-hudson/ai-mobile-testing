import type { AuditEnvironment } from './types.js';
import {
  HUMAN_SITEMAP_EXCLUDED_PATHS,
  type CandidateRoute,
  type CategoryIndexContract,
  type HeaderBreakpointContract,
  type HomeSupportStateContract,
  type ReviewedHeaderControl,
} from './routes.js';

export interface RouteStructureEvidence {
  actualPathname: string;
  canonical: string | null;
  canonicalPathname: string | null;
  canonicalOrigin: string | null;
  title: string;
  h1Text: string;
  mainH1Count: number;
  mainCharacters: number;
  visibleArticleCount: number;
  articleCharacters: number;
  proseBlockLengths: number[];
  sectionHeadingCount: number;
  mainInternalPaths: string[];
  enabledFormControlCount: number;
  searchInputs: Array<{ accessibleName: string; disabled: boolean }>;
  urgentLinkCount: number;
}

export interface RouteContractContext {
  environment: AuditEnvironment;
  expectedPathname: string;
  approvedCanonicalOrigins: readonly string[];
  expectedChildPaths: readonly string[];
  declaredRoutePaths: readonly string[];
}

export interface CategoryIndexItemEvidence {
  path: string;
  title: string;
  lastUpdated: string;
  summary: string;
  visible: boolean;
}

export interface CategoryIndexEvidence {
  reportedPageCount: number | null;
  groupCount: number;
  items: CategoryIndexItemEvidence[];
}

export interface HomeSupportActionEvidence {
  accessibleName: string;
  href: string;
  target: string | null;
  rel: string | null;
}

export interface HomeSupportStateEvidence {
  id: string;
  at: string;
  textLines: string[];
  actions: HomeSupportActionEvidence[];
}

export interface DarkThemePaintEvidence {
  dark: boolean;
  mode: string | null;
  background: string | null;
  foreground: string | null;
  readyState: string;
}

export interface HeaderControlEvidence {
  id: string;
  accessibleName: string;
  href: string | null;
  box: { left: number; right: number; top: number; bottom: number; width: number; height: number };
}

export interface HeaderBreakpointEvidence {
  width: number;
  controls: HeaderControlEvidence[];
}

export function normalizedPathname(value: string): string {
  const pathname = new URL(value, 'https://audit.invalid').pathname.replace(/\/+$/, '');
  return pathname || '/';
}

export function normalizedIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(' ') ?? '';
}

export function normalizedTitleCore(value: string): string {
  return normalizedIdentity(value.replace(/\s+(?:·|\||—|-)\s+quitting7oh\.org\s*$/i, ''));
}

function acceptedIdentity(primary: string, aliases: readonly string[] | undefined, environment: AuditEnvironment): string[] {
  return [primary, ...(environment === 'production' ? aliases ?? [] : [])].map(normalizedIdentity);
}

function distinctDeclaredPaths(paths: readonly string[], declaredPaths: ReadonlySet<string>): string[] {
  return [...new Set(paths.map(normalizedPathname).filter((path) => declaredPaths.has(path)))];
}

function routeGroup(path: string): string {
  return normalizedPathname(path).split('/').filter(Boolean)[0] ?? '/';
}

export function evaluateCategoryIndexContract(
  contract: CategoryIndexContract,
  evidence: CategoryIndexEvidence,
): string[] {
  const issues: string[] = [];
  if (evidence.reportedPageCount !== contract.items.length) {
    issues.push(`category reports ${String(evidence.reportedPageCount)} pages instead of ${contract.items.length}`);
  }
  if (evidence.groupCount !== contract.expectedGroupCount) {
    issues.push(`category renders ${evidence.groupCount} list groups instead of ${contract.expectedGroupCount}`);
  }
  if (evidence.items.length !== contract.items.length) {
    issues.push(`category renders ${evidence.items.length} cards instead of ${contract.items.length}`);
  }
  const duplicatePaths = evidence.items
    .map(({ path }) => normalizedPathname(path))
    .filter((path, index, paths) => paths.indexOf(path) !== index);
  if (duplicatePaths.length > 0) issues.push(`category repeats destinations: ${[...new Set(duplicatePaths)].join(', ')}`);

  const actualIdentity = evidence.items.map(({ path, title, lastUpdated }) => ({
    path: normalizedPathname(path),
    title: title.replace(/\s+/g, ' ').trim(),
    lastUpdated: lastUpdated.slice(0, 10),
  }));
  const expectedIdentity = contract.items.map(({ path, title, lastUpdated }) => ({
    path: normalizedPathname(path),
    title,
    lastUpdated,
  }));
  if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {
    issues.push('category card paths, titles, order, or reviewed update dates do not match the inventory');
  }
  for (const item of evidence.items) {
    if (!item.visible) issues.push(`category card ${normalizedPathname(item.path)} is not visibly rendered`);
    if (item.summary.replace(/\s+/g, ' ').trim().length < 40) {
      issues.push(`category card ${normalizedPathname(item.path)} has no substantive summary metadata`);
    }
  }
  return issues;
}

function normalizedRel(value: string | null): string | null {
  if (value === null) return null;
  return value.split(/\s+/).filter(Boolean).sort().join(' ');
}

export function evaluateHomeSupportStateContract(
  contract: HomeSupportStateContract,
  evidence: HomeSupportStateEvidence,
): string[] {
  const issues: string[] = [];
  if (evidence.id !== contract.id) issues.push(`support state ${evidence.id} does not equal ${contract.id}`);
  if (evidence.at !== contract.at) issues.push(`support clock ${evidence.at} does not equal ${contract.at}`);
  const textLines = evidence.textLines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const requiredLine of contract.requiredTextLines) {
    if (!textLines.includes(requiredLine)) issues.push(`support state omits exact text line ${JSON.stringify(requiredLine)}`);
  }
  if (evidence.actions.length !== contract.actions.length) {
    issues.push(`support state exposes ${evidence.actions.length} actions instead of exactly ${contract.actions.length}`);
  }
  for (const [index, expected] of contract.actions.entries()) {
    const actual = evidence.actions[index];
    if (!actual) {
      issues.push(`support action ${JSON.stringify(expected.accessibleName)} is missing at reviewed position ${index + 1}`);
      continue;
    }
    if (actual.accessibleName !== expected.accessibleName
      || actual.href !== expected.href
      || actual.target !== expected.target
      || normalizedRel(actual.rel) !== normalizedRel(expected.rel)) {
      issues.push(`support action at position ${index + 1} does not equal ${JSON.stringify(expected.accessibleName)} and its reviewed destination/tab metadata`);
    }
  }
  return issues;
}

function parseRgb(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const match = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,[^)]*)?\)$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function evaluateDarkThemePaintContract(evidence: DarkThemePaintEvidence): string[] {
  const issues: string[] = [];
  if (!evidence.dark) issues.push('first animation frame lacks the stored dark class');
  if (evidence.mode !== 'dark') issues.push(`first animation frame exposes theme mode ${String(evidence.mode)} instead of dark`);
  const background = parseRgb(evidence.background);
  const foreground = parseRgb(evidence.foreground);
  if (!background) issues.push(`first-frame background ${String(evidence.background)} is not an inspectable RGB color`);
  if (!foreground) issues.push(`first-frame foreground ${String(evidence.foreground)} is not an inspectable RGB color`);
  if (background && foreground) {
    const backgroundLuminance = relativeLuminance(background);
    const foregroundLuminance = relativeLuminance(foreground);
    const contrast = (Math.max(backgroundLuminance, foregroundLuminance) + 0.05)
      / (Math.min(backgroundLuminance, foregroundLuminance) + 0.05);
    if (backgroundLuminance > 0.15) issues.push(`first-frame background luminance ${backgroundLuminance.toFixed(3)} is not visually dark`);
    if (contrast < 4.5) issues.push(`first-frame text contrast ${contrast.toFixed(2)} is below 4.5:1`);
  }
  return issues;
}

export function evaluateHeaderBreakpointContract(
  contract: HeaderBreakpointContract,
  controlContracts: readonly ReviewedHeaderControl[],
  evidence: HeaderBreakpointEvidence,
): string[] {
  const issues: string[] = [];
  if (evidence.width !== contract.width) issues.push(`header width ${evidence.width} does not equal ${contract.width}`);
  const actualIds = evidence.controls.map(({ id }) => id);
  if (JSON.stringify(actualIds) !== JSON.stringify(contract.controlIds)) {
    issues.push(`visible header controls ${actualIds.join(', ')} do not equal the reviewed breakpoint inventory ${contract.controlIds.join(', ')}`);
  }
  const contractsById = new Map(controlContracts.map((control) => [control.id, control]));
  for (const actual of evidence.controls) {
    const expected = contractsById.get(actual.id as ReviewedHeaderControl['id']);
    if (!expected) {
      issues.push(`header exposes unreviewed control ${actual.id}`);
      continue;
    }
    const nameMatches = expected.nameMatch === 'exact'
      ? actual.accessibleName === expected.accessibleName
      : actual.accessibleName.startsWith(expected.accessibleName);
    if (!nameMatches) issues.push(`header control ${actual.id} has accessible name ${JSON.stringify(actual.accessibleName)} instead of ${expected.nameMatch} ${JSON.stringify(expected.accessibleName)}`);
    if (actual.href !== expected.href) issues.push(`header control ${actual.id} targets ${String(actual.href)} instead of ${String(expected.href)}`);
    if (actual.box.width < expected.minimumWidth || actual.box.height < expected.minimumHeight) {
      issues.push(`header control ${actual.id} is ${actual.box.width.toFixed(1)}x${actual.box.height.toFixed(1)}px, below ${expected.minimumWidth}x${expected.minimumHeight}px`);
    }
    if (actual.box.left < -1 || actual.box.right > contract.width + 1 || actual.box.top < -1) {
      issues.push(`header control ${actual.id} clips outside the ${contract.width}px viewport`);
    }
  }
  for (const [index, left] of evidence.controls.entries()) {
    for (const right of evidence.controls.slice(index + 1)) {
      const overlapX = Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left);
      const overlapY = Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top);
      if (overlapX > 2 && overlapY > 2) issues.push(`header controls ${left.id} and ${right.id} overlap by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px`);
    }
  }
  return issues;
}

export function evaluateRouteContract(
  route: CandidateRoute,
  evidence: RouteStructureEvidence,
  context: RouteContractContext,
): string[] {
  const issues: string[] = [];
  const expectedPathname = normalizedPathname(context.expectedPathname);
  const acceptedH1 = acceptedIdentity(route.expectedH1, route.productionH1Aliases, context.environment);
  const acceptedTitle = acceptedIdentity(route.expectedTitle, route.productionTitleAliases, context.environment);
  const actualH1 = normalizedIdentity(evidence.h1Text);
  const actualTitle = normalizedTitleCore(evidence.title);
  const declaredPaths = new Set(context.declaredRoutePaths.map(normalizedPathname));
  const internalPaths = distinctDeclaredPaths(evidence.mainInternalPaths, declaredPaths);

  if (normalizedPathname(evidence.actualPathname) !== expectedPathname) {
    issues.push(`loaded pathname ${normalizedPathname(evidence.actualPathname)} does not equal ${expectedPathname}`);
  }
  if (evidence.canonical === null || evidence.canonicalPathname === null || evidence.canonicalOrigin === null) {
    issues.push('canonical destination is missing or malformed');
  } else {
    if (normalizedPathname(evidence.canonicalPathname) !== expectedPathname) {
      issues.push(`canonical pathname ${normalizedPathname(evidence.canonicalPathname)} does not equal ${expectedPathname}`);
    }
    if (!context.approvedCanonicalOrigins.includes(evidence.canonicalOrigin)) {
      issues.push(`canonical origin ${evidence.canonicalOrigin} is not approved`);
    }
  }
  if (evidence.mainH1Count !== 1) issues.push(`main contains ${evidence.mainH1Count} visible H1 elements instead of exactly one`);
  if (!acceptedH1.includes(actualH1)) issues.push(`H1 ${JSON.stringify(evidence.h1Text)} is not a reviewed identity for ${route.path}`);
  if (!acceptedTitle.includes(actualTitle)) issues.push(`title ${JSON.stringify(evidence.title)} is not a reviewed identity for ${route.path}`);
  if (evidence.mainCharacters <= 120) issues.push(`main contains only ${evidence.mainCharacters} visible characters`);

  switch (route.kind) {
    case 'article':
      if (evidence.visibleArticleCount !== 1) issues.push(`article route has ${evidence.visibleArticleCount} visible main articles instead of one`);
      if (evidence.articleCharacters < 400) issues.push(`article contains only ${evidence.articleCharacters} visible characters`);
      if (evidence.proseBlockLengths.length < 3) issues.push('article has fewer than three visible prose blocks');
      if (evidence.proseBlockLengths.filter((length) => length >= 40).length < 3) {
        issues.push('article has fewer than three substantive prose blocks of at least 40 characters');
      }
      if (evidence.sectionHeadingCount < 1) issues.push('article has no visible section heading');
      break;
    case 'calculator':
      if (evidence.visibleArticleCount !== 1) issues.push(`calculator route has ${evidence.visibleArticleCount} visible main articles instead of one`);
      if (evidence.articleCharacters <= 120) issues.push(`calculator article contains only ${evidence.articleCharacters} visible characters`);
      if (route.path === '/resources/taper-calculator') {
        const calculatorChildren = internalPaths.filter((path) => /^\/resources\/(?:7-oh|kratom-leaf|sr-17|suboxone)-taper-calculator$/.test(path));
        if (calculatorChildren.length < 4) issues.push(`calculator directory exposes only ${calculatorChildren.length} of four reviewed calculators`);
      } else if (evidence.enabledFormControlCount < 1) {
        issues.push('calculator exposes no visible enabled input, select, or textarea');
      }
      break;
    case 'category': {
      const expectedChildren = new Set(context.expectedChildPaths.map(normalizedPathname));
      const presentChildren = internalPaths.filter((path) => expectedChildren.has(path));
      const missingChildren = [...expectedChildren].filter((path) => !presentChildren.includes(path));
      if (missingChildren.length > 0) {
        issues.push(`category omits ${missingChildren.length} reviewed immediate child route${missingChildren.length === 1 ? '' : 's'}: ${missingChildren.join(', ')}`);
      }
      break;
    }
    case 'home': {
      const groups = new Set(internalPaths.map(routeGroup));
      if (internalPaths.length < 4) issues.push(`home exposes only ${internalPaths.length} reviewed destinations`);
      if (groups.size < 3) issues.push(`home destinations span only ${groups.size} route groups`);
      break;
    }
    case 'search': {
      const usableSearch = evidence.searchInputs.some(({ accessibleName, disabled }) => !disabled && normalizedIdentity(accessibleName).length > 0);
      if (!usableSearch) issues.push('search route has no visible enabled, accessibly named search input');
      break;
    }
    case 'crisis':
      if (evidence.urgentLinkCount < 1) issues.push('crisis route exposes no visible urgent action destination');
      if (internalPaths.length < 1) issues.push('crisis route exposes no reviewed same-site recovery destination');
      break;
    case 'meeting':
      if (internalPaths.length < 1) issues.push('meeting route exposes no reviewed same-site follow-up destination');
      if (evidence.sectionHeadingCount < 1 && evidence.enabledFormControlCount < 1 && evidence.visibleArticleCount < 1) {
        issues.push('meeting route exposes neither meeting sections, controls, nor a substantive schedule article');
      }
      break;
    case 'utility':
      if (route.path === '/sitemap') {
        const excluded = new Set(HUMAN_SITEMAP_EXCLUDED_PATHS.map(normalizedPathname));
        const expectedDestinations = [...declaredPaths].filter((path) => !excluded.has(path));
        const missingDestinations = expectedDestinations.filter((path) => !internalPaths.includes(path));
        if (missingDestinations.length > 0) {
          issues.push(`site map omits ${missingDestinations.length} reviewed destination${missingDestinations.length === 1 ? '' : 's'}: ${missingDestinations.join(', ')}`);
        }
      } else if (route.path === '/brand') {
        if (evidence.sectionHeadingCount < 4) issues.push(`brand guide exposes only ${evidence.sectionHeadingCount} visible section headings`);
      } else {
        issues.push(`utility route ${route.path} has no explicit structural contract`);
      }
      break;
    default: {
      const exhaustive: never = route.kind;
      issues.push(`route kind ${exhaustive} has no structural contract`);
    }
  }

  return issues;
}
