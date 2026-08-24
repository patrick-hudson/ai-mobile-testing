import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_AUDIT_CATALOG, INSTALLED_PLUGIN_REGISTRY, ROUTE_AUDIT_CATALOG } from '../audit/definitions.js';

const TEST_HELPER_PATTERN = /\b(interactionTest|staticTest|structuredTest)\s*\(/g;
const EXPECT_PATTERN = /\bexpect(?:\.(?:poll|soft))?\s*\(/g;
const RUNTIME_ORACLE_PATTERN = /\baudit\.(?:assertRuntimeHealthy|expectConsoleError|expectPageError|expectRequestFailure|expectResponseStatus)\s*\(/g;
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

interface Span {
  start: number;
  end: number;
}

interface ParsedCall {
  args: string[];
  end: number;
}

interface SourceFinding {
  file: string;
  line: number;
  test: string;
  detail: string;
}

interface DeclarationSummary {
  file: string;
  line: number;
  title: string;
  auditIds: string[];
  applicability: string | null;
  oracleCount: number;
  unconditionalOracleCount: number;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function previousWord(source: string, index: number): string {
  const match = source.slice(0, index).match(/([A-Za-z_$][\w$]*)\s*$/);
  return match?.[1] ?? '';
}

function slashStartsRegex(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1;
  if (cursor < 0) return true;
  if (/[(\[{,:;=!?&|+\-*%^~<>]/.test(source[cursor]!)) return true;
  return /^(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield|await)$/.test(previousWord(source, index));
}

function consumeQuoted(source: string, index: number, quote: string): number {
  let escaped = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) return cursor + 1;
  }
  return source.length;
}

function consumeRegex(source: string, index: number): number {
  let escaped = false;
  let characterClass = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '[') characterClass = true;
    else if (character === ']') characterClass = false;
    else if (character === '/' && !characterClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor]!)) cursor += 1;
      return cursor;
    } else if (character === '\n' || character === '\r') return cursor;
  }
  return source.length;
}

function lexicalSpecialEnd(source: string, index: number): number | null {
  const character = source[index]!;
  if (character === "'" || character === '"' || character === '`') return consumeQuoted(source, index, character);
  if (character !== '/') return null;
  if (source[index + 1] === '/') {
    const newline = source.indexOf('\n', index + 2);
    return newline < 0 ? source.length : newline;
  }
  if (source[index + 1] === '*') {
    const close = source.indexOf('*/', index + 2);
    return close < 0 ? source.length : close + 2;
  }
  return slashStartsRegex(source, index) ? consumeRegex(source, index) : null;
}

function parseCall(source: string, openParenthesis: number): ParsedCall | null {
  const args: string[] = [];
  const stack = ['('];
  let argumentStart = openParenthesis + 1;
  for (let index = openParenthesis + 1; index < source.length; index += 1) {
    const specialEnd = lexicalSpecialEnd(source, index);
    if (specialEnd !== null) {
      index = specialEnd - 1;
      continue;
    }
    const character = source[index]!;
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      if (stack.length === 0) {
        args.push(source.slice(argumentStart, index).trim());
        return { args, end: index + 1 };
      }
    } else if (character === ',' && stack.length === 1) {
      args.push(source.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }
  return null;
}

function sanitize(source: string): string {
  const output = [...source];
  for (let index = 0; index < source.length; index += 1) {
    const end = lexicalSpecialEnd(source, index);
    if (end === null) continue;
    for (let cursor = index; cursor < end; cursor += 1) {
      if (source[cursor] !== '\n' && source[cursor] !== '\r') output[cursor] = ' ';
    }
    index = end - 1;
  }
  return output.join('');
}

function matchingDelimiter(source: string, open: number, opening: string, closing: string): number | null {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function guardedSpans(source: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\b(?:if|for|while)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const conditionEnd = matchingDelimiter(source, open, '(', ')');
    if (conditionEnd === null) continue;
    let statementStart = conditionEnd + 1;
    while (/\s/.test(source[statementStart] ?? '')) statementStart += 1;
    let statementEnd: number;
    if (source[statementStart] === '{') {
      statementEnd = matchingDelimiter(source, statementStart, '{', '}') ?? source.length;
    } else {
      const semicolon = source.indexOf(';', statementStart);
      statementEnd = semicolon < 0 ? source.length : semicolon;
    }
    spans.push({ start: statementStart, end: statementEnd + 1 });
  }
  return spans;
}

function literalTitle(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+/g, ' ').slice(0, 240);
}

function evidenceApplicability(value: string | undefined): string | null {
  return value?.match(/,\s*(['"])([^'"]+)\1\s*\)\s*$/)?.[2] ?? null;
}

function staticLiteral(value: string): boolean {
  const normalized = value.trim().replace(/^\((.*)\)$/s, '$1').trim();
  if (/^(?:true|false|null|undefined|NaN|[-+]?\d+(?:\.\d+)?n?)$/.test(normalized)) return true;
  if (/^(?:['"`]|\/)/.test(normalized)) return true;
  if (/^\[\s*(?:(?:[-+]?\d+(?:\.\d+)?|true|false|null|['"][^'"]*['"])(?:\s*,\s*)?)*\]$/.test(normalized)) return true;
  if (/^\{\s*\}$/.test(normalized)) return true;
  return false;
}

function normalizedExpression(value: string): string {
  return value.replace(/\s+/g, '').replace(/^\((.*)\)$/s, '$1');
}

function analyzeExpectations(file: string, originalBody: string, title: string, bodyLine: number): {
  oraclePositions: number[];
  findings: SourceFinding[];
} {
  const findings: SourceFinding[] = [];
  const oraclePositions: number[] = [];
  const cleanBody = sanitize(originalBody);
  for (const match of cleanBody.matchAll(EXPECT_PATTERN)) {
    const start = match.index ?? 0;
    oraclePositions.push(start);
    const open = start + match[0].lastIndexOf('(');
    const parsed = parseCall(originalBody, open);
    if (!parsed) {
      findings.push({ file, line: bodyLine + lineAt(originalBody, start) - 1, test: title, detail: 'Expect invocation cannot be parsed safely.' });
      continue;
    }
    const tail = originalBody.slice(parsed.end);
    const matcherPrefix = tail.match(/^\s*(?:\.not)?\.(to[A-Za-z0-9_$]+)\s*\(/);
    const actual = parsed.args[0] ?? '';
    if (!matcherPrefix) {
      findings.push({ file, line: bodyLine + lineAt(originalBody, start) - 1, test: title, detail: 'Expect invocation has no concrete matcher.' });
      continue;
    }
    const matcherOpen = parsed.end + (matcherPrefix.index ?? 0) + matcherPrefix[0].lastIndexOf('(');
    const matcherCall = parseCall(originalBody, matcherOpen);
    const expected = matcherCall?.args[0];
    const allowedSetContainsObservation = matcherPrefix[1] === 'toContain'
      && expected !== undefined
      && !staticLiteral(expected);
    if (staticLiteral(actual) && !allowedSetContainsObservation) {
      findings.push({ file, line: bodyLine + lineAt(originalBody, start) - 1, test: title, detail: 'Assertion tests a source literal instead of an observed product value.' });
    }
    if (expected && EQUALITY_MATCHERS.has(matcherPrefix[1]!)
      && normalizedExpression(actual) === normalizedExpression(expected)) {
      findings.push({ file, line: bodyLine + lineAt(originalBody, start) - 1, test: title, detail: 'Assertion compares an expression with itself.' });
    }
  }
  for (const match of cleanBody.matchAll(RUNTIME_ORACLE_PATTERN)) oraclePositions.push(match.index ?? 0);
  for (const match of cleanBody.matchAll(/\|\|\s*true\b/g)) {
    findings.push({ file, line: bodyLine + lineAt(originalBody, match.index ?? 0) - 1, test: title, detail: '`|| true` can convert a failed product condition into a pass.' });
  }
  for (const match of cleanBody.matchAll(/\.catch\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const parsed = parseCall(originalBody, open);
    if (parsed && !/\bthrow\b/.test(sanitize(parsed.args[0] ?? ''))) {
      findings.push({ file, line: bodyLine + lineAt(originalBody, match.index ?? 0) - 1, test: title, detail: 'Promise rejection is swallowed by a catch handler that never throws.' });
    }
  }
  return { oraclePositions, findings };
}

export function analyzeAssertionSource(file: string, source: string): {
  declarations: DeclarationSummary[];
  findings: SourceFinding[];
} {
  const declarations: DeclarationSummary[] = [];
  const findings: SourceFinding[] = [];
  const cleanSource = sanitize(source);
  for (const match of cleanSource.matchAll(TEST_HELPER_PATTERN)) {
    const declarationStart = match.index ?? 0;
    const open = declarationStart + match[0].lastIndexOf('(');
    const parsed = parseCall(source, open);
    if (!parsed || parsed.args.length < 3) {
      findings.push({ file, line: lineAt(source, declarationStart), test: '<unresolved>', detail: 'Audit declaration must have a title, evidence policy, and executable function body.' });
      continue;
    }
    const title = literalTitle(parsed.args[0]!);
    const auditIds = [...title.matchAll(/\[([A-Z0-9]+(?:-[A-Z0-9]+)+)\]/g)].map((idMatch) => idMatch[1]!);
    const applicability = evidenceApplicability(parsed.args[1]);
    const body = parsed.args[2]!;
    const bodyOffset = source.indexOf(body, open);
    const bodyLine = lineAt(source, Math.max(open, bodyOffset));
    const result = analyzeExpectations(file, body, title, bodyLine);
    findings.push(...result.findings);
    const guards = guardedSpans(sanitize(body));
    const unconditionalOracleCount = result.oraclePositions.filter((position) => (
      !guards.some(({ start, end }) => position >= start && position < end)
    )).length;
    if (result.oraclePositions.length === 0) {
      findings.push({ file, line: lineAt(source, declarationStart), test: title, detail: 'Automated audit has no product-facing assertion or runtime oracle.' });
    } else if (unconditionalOracleCount === 0) {
      findings.push({ file, line: lineAt(source, declarationStart), test: title, detail: 'Every product oracle is conditional; the audit can pass without executing an assertion.' });
    }
    declarations.push({
      file,
      line: lineAt(source, declarationStart),
      title,
      auditIds,
      applicability,
      oracleCount: result.oraclePositions.length,
      unconditionalOracleCount,
    });
  }
  return { declarations, findings };
}

function runMutationCanaries(): void {
  const wrap = (body: string) => `structuredTest('[CANARY-001] canary', structuredEvidence('Retain real evidence.', 'all-projects'), async ({ audit }) => { ${body} });`;
  const problems = (body: string) => analyzeAssertionSource('canary.spec.ts', wrap(body)).findings.map(({ detail }) => detail);
  assert(problems('expect(true).toBe(true);').some((detail) => detail.includes('source literal')));
  assert(problems('const result = await probe(); expect(result).toBe(result);').some((detail) => detail.includes('itself')));
  assert(problems('if (await probe()) { expect(await value()).toBe(1); }').some((detail) => detail.includes('conditional')));
  assert(problems('await probe().catch(() => false); expect(await value()).toBe(1);').some((detail) => detail.includes('swallowed')));
  assert(problems('const result = (await probe()) || true; expect(result).toBe(true);').some((detail) => detail.includes('`|| true`')));
  assert(problems('audit.observe("only metadata", 1, "1");').some((detail) => detail.includes('no product-facing')));
  assert.deepEqual(problems('expect(await responseStatus()).toBe(200);'), []);
  assert.deepEqual(problems('await audit.assertRuntimeHealthy();'), []);
}

runMutationCanaries();

const repositoryRoot = process.cwd();
const entrySpecs = [...new Set(INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ entrySpecs }) => entrySpecs))].sort();
const declarations: DeclarationSummary[] = [];
const findings: SourceFinding[] = [];
for (const entrySpec of entrySpecs) {
  const result = analyzeAssertionSource(entrySpec, readFileSync(path.join(repositoryRoot, entrySpec), 'utf8'));
  declarations.push(...result.declarations);
  findings.push(...result.findings);
}

const declarationCases = new Set(declarations.flatMap((declaration) => declaration.auditIds.map((auditId) => (
  `${auditId}\0${declaration.file}\0${declaration.applicability ?? ''}`
))));
for (const plugin of INSTALLED_PLUGIN_REGISTRY.plugins) {
  for (const auditCase of plugin.auditCases) {
    const key = `${auditCase.auditId}\0${auditCase.entrySpec}\0${auditCase.applicability}`;
    if (!declarationCases.has(key)) {
      findings.push({ file: auditCase.entrySpec, line: 1, test: auditCase.auditId, detail: `Generated audit case ${auditCase.applicability} has no matching executable declaration.` });
    }
  }
}

const dynamicRouteDeclaration = declarations.find(({ file, title, applicability }) => (
  file === 'tests/page-audit.spec.ts'
  && title.includes('${definition.id}')
  && applicability === 'full-sweep-projects'
));
if (!dynamicRouteDeclaration || dynamicRouteDeclaration.unconditionalOracleCount === 0) {
  findings.push({
    file: 'tests/page-audit.spec.ts',
    line: 1,
    test: 'PAGE-*',
    detail: 'Route-specific audit contracts require one full-sweep dynamic declaration with an unconditional product oracle.',
  });
}

const automatedAuditIds = new Set(ALL_AUDIT_CATALOG.filter(({ manual }) => !manual).map(({ id }) => id));
const executableAuditIds = new Set(
  INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases.map(({ auditId }) => auditId)),
);
if (dynamicRouteDeclaration) {
  for (const { id } of ROUTE_AUDIT_CATALOG) executableAuditIds.add(id);
}
const auditsWithoutExecutableCase = [...automatedAuditIds].filter((id) => !executableAuditIds.has(id)).sort();
if (auditsWithoutExecutableCase.length > 0) {
  findings.push({
    file: 'audit catalog',
    line: 1,
    test: auditsWithoutExecutableCase.join(', '),
    detail: 'Automated audit contracts have no executable static or generated route case.',
  });
}

for (const definition of ALL_AUDIT_CATALOG) {
  if ((definition.severity === 'P0' || definition.severity === 'P1') && !definition.releaseBlocking) {
    findings.push({ file: 'audit catalog', line: 1, test: definition.id, detail: `${definition.severity} audit is not release blocking.` });
  }
  for (const [field, value] of [['userPromise', definition.userPromise], ['expected', definition.expected]] as const) {
    if (value.replace(/\s+/g, ' ').trim().length < 12 || /\b(?:todo|tbd|replace this|describe the)\b/i.test(value)) {
      findings.push({ file: 'audit catalog', line: 1, test: definition.id, detail: `${field} is placeholder-quality rather than an actionable product contract.` });
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Assertion-quality gate failed:\n${findings.map(({ file, line, test, detail }) => `- ${file}:${line} ${test}: ${detail}`).join('\n')}`);
}

process.stdout.write(`Assertion-quality self-test passed: ${declarations.length} declarations exercise ${automatedAuditIds.size} automated audit contracts with non-optional product oracles; mutation canaries rejected tautologies, swallowed failures, and conditional-only assertions.\n`);
