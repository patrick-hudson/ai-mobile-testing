import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-api';
import { ALL_AUDIT_CATALOG, INSTALLED_PLUGIN_REGISTRY, ROUTE_AUDIT_CATALOG } from '../audit/definitions.js';
import { classifyHorizontalOverflowCandidates, type RawHorizontalOverflowCandidate } from '../audit/overflow-evidence.js';
import {
  evaluateCategoryIndexContract,
  evaluateDarkThemePaintContract,
  evaluateHeaderBreakpointContract,
  evaluateHomeSupportStateContract,
  evaluateRouteContract,
  type RouteContractContext,
  type RouteStructureEvidence,
} from '../audit/page-oracles.js';
import { PAGE_AUDIT_ENTRY_SPEC, pageAuditFamilyMembers } from '../audit/page-audit-family.js';
import { resolveEnvironmentPath } from '../audit/environments.js';
import {
  CANDIDATE_HTML_ROUTES,
  HUMAN_SITEMAP_EXCLUDED_PATHS,
  REVIEWED_HEADER_BREAKPOINTS,
  REVIEWED_HEADER_CONTROLS,
  REVIEWED_HOME_SUPPORT_STATES,
  REPRESENTATIVE_RUNTIME_ROUTES,
  START_HERE_CATEGORY_INDEX_CONTRACT,
  type CandidateRoute,
  type CandidateRouteKind,
} from '../audit/routes.js';

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);
const TEST_HELPERS = new Set(['interactionTest', 'staticTest', 'structuredTest', 'standaloneStaticTest']);
const RUNTIME_ORACLES = new Set(['assertRuntimeHealthy', 'expectConsoleError', 'expectPageError', 'expectRequestFailure', 'expectResponseStatus']);

type CallableKind = 'test-helper' | 'expect' | 'expect-poll' | 'expect-soft';

interface AssertionAliases {
  identifiers: Map<string, CallableKind>;
  namespaces: Set<string>;
  callbackBodies: Map<string, ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration>;
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

function literalTitle(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+/g, ' ').slice(0, 240);
}

function evidenceApplicability(value: string | undefined): string | null {
  if (/^standaloneStaticEvidence\s*\(/.test(value?.trim() ?? '')) {
    return value?.match(/,\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*,?\s*\)\s*$/)?.[2] ?? null;
  }
  return value?.match(/,\s*(['"])([^'"]+)\1(?:\s*,\s*(?:[A-Za-z_$][\w$]*|(['"])[^'"]+\3))?\s*\)\s*$/)?.[2] ?? null;
}

function staticLiteral(value: string): boolean {
  const normalized = value.trim().replace(/^\((.*)\)$/s, '$1').trim();
  if (/^(?:true|false|null|undefined|NaN|[-+]?\d+(?:\.\d+)?n?)$/.test(normalized)) return true;
  if (/^(?:['"`]|\/)/.test(normalized)) return true;
  if (/^\[\s*(?:(?:[-+]?\d+(?:\.\d+)?|true|false|null|['"][^'"]*['"])(?:\s*,\s*)?)*\]$/.test(normalized)) return true;
  if (/^\{\s*\}$/.test(normalized)) return true;
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  const argument = expression.argumentExpression;
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : null;
}

function callableKind(expression: ts.Expression, aliases: AssertionAliases): CallableKind | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return aliases.identifiers.get(unwrapped.text) ?? null;
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return null;
  const member = propertyName(unwrapped);
  if (!member) return null;
  const receiver = unwrapExpression(unwrapped.expression);
  if (ts.isIdentifier(receiver) && aliases.namespaces.has(receiver.text)) {
    if (member === 'expect') return 'expect';
    if (TEST_HELPERS.has(member)) return 'test-helper';
  }
  const receiverKind = callableKind(receiver, aliases);
  if (receiverKind === 'expect' && member === 'poll') return 'expect-poll';
  if (receiverKind === 'expect' && member === 'soft') return 'expect-soft';
  return null;
}

function collectAssertionAliases(sourceFile: ts.SourceFile): AssertionAliases {
  const aliases: AssertionAliases = {
    identifiers: new Map<string, CallableKind>([
      ['expect', 'expect'],
      ...[...TEST_HELPERS].map((name) => [name, 'test-helper'] as [string, CallableKind]),
    ]),
    namespaces: new Set<string>(),
    callbackBodies: new Map<string, ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration>(),
  };
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) aliases.namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (importedName === 'expect') aliases.identifiers.set(specifier.name.text, 'expect');
          else if (TEST_HELPERS.has(importedName)) aliases.identifiers.set(specifier.name.text, 'test-helper');
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
      if (ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        aliases.callbackBodies.set(node.name.text, node.initializer);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      aliases.callbackBodies.set(node.name.text, node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      if (!declaration.initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        const kind = callableKind(declaration.initializer, aliases);
        if (kind && aliases.identifiers.get(declaration.name.text) !== kind) {
          aliases.identifiers.set(declaration.name.text, kind);
          changed = true;
        }
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isIdentifier(initializer) || !aliases.namespaces.has(initializer.text)) continue;
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        const kind: CallableKind | null = importedName === 'expect'
          ? 'expect'
          : TEST_HELPERS.has(importedName) ? 'test-helper' : null;
        if (kind && aliases.identifiers.get(element.name.text) !== kind) {
          aliases.identifiers.set(element.name.text, kind);
          changed = true;
        }
      }
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      const kind = callableKind(assignment.right, aliases);
      if (kind && aliases.identifiers.get(assignment.left.text) !== kind) {
        aliases.identifiers.set(assignment.left.text, kind);
        changed = true;
      }
    }
  }
  return aliases;
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function matcherForExpect(call: ts.CallExpression): { name: string; call: ts.CallExpression } | null {
  let cursor: ts.Node = call;
  let member = cursor.parent;
  if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member))
    && member.expression === cursor && propertyName(member) === 'not') {
    cursor = member;
    member = cursor.parent;
  }
  if ((!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) || member.expression !== cursor) return null;
  const name = propertyName(member);
  if (!name?.startsWith('to') || !ts.isCallExpression(member.parent) || member.parent.expression !== member) return null;
  return { name, call: member.parent };
}

function callbackReturnExpressions(
  expression: ts.Expression,
  aliases: AssertionAliases,
  seen = new Set<string>(),
): { expressions: ts.Expression[]; returnsUndefined: boolean } | null {
  let callback: ts.Expression | ts.FunctionDeclaration = unwrapExpression(expression);
  if (ts.isIdentifier(callback)) {
    if (seen.has(callback.text)) return null;
    seen.add(callback.text);
    const resolved = aliases.callbackBodies.get(callback.text);
    if (!resolved) return null;
    callback = resolved;
  }
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && !ts.isFunctionDeclaration(callback)) return null;
  const callbackBody = callback.body;
  if (!callbackBody) return null;
  if (!ts.isBlock(callbackBody)) return { expressions: [callbackBody], returnsUndefined: false };
  const expressions: ts.Expression[] = [];
  let bareReturn = false;
  const visit = (node: ts.Node): void => {
    if (node !== callback && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) expressions.push(node.expression);
      else bareReturn = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callbackBody);
  return { expressions, returnsUndefined: bareReturn || expressions.length === 0 };
}

function normalizedNodeExpression(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  let current = unwrapExpression(expression);
  while (ts.isAwaitExpression(current)) current = unwrapExpression(current.expression);
  return current.getText(sourceFile).replace(/\s+/g, '');
}

function conditionallyExecuted(node: ts.Node, body: ts.Node): boolean {
  let current = node;
  while (current.parent && current !== body) {
    const parent = current.parent;
    if (ts.isIfStatement(parent) && (current === parent.thenStatement || current === parent.elseStatement)) return true;
    if ((ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)
      || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && current === parent.statement) return true;
    current = parent;
  }
  return false;
}

function analyzeExpectations(
  file: string,
  sourceFile: ts.SourceFile,
  body: ts.Expression,
  title: string,
  aliases: AssertionAliases,
): { oracleNodes: ts.Node[]; findings: SourceFinding[] } {
  const findings: SourceFinding[] = [];
  const oracleNodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = callableKind(node.expression, aliases);
      if (kind === 'expect' || kind === 'expect-poll' || kind === 'expect-soft') {
        oracleNodes.push(node);
        const matcher = matcherForExpect(node);
        const line = sourceLine(sourceFile, node);
        if (!matcher) {
          findings.push({ file, line, test: title, detail: 'Expect invocation has no concrete matcher.' });
        } else {
          const expected = matcher.call.arguments[0];
          const observed = kind === 'expect-poll'
            ? node.arguments[0] ? callbackReturnExpressions(node.arguments[0], aliases) : null
            : node.arguments[0] ? { expressions: [node.arguments[0]], returnsUndefined: false } : null;
          if (!observed) {
            if (kind !== 'expect-poll') findings.push({ file, line, test: title, detail: 'Expect invocation has no observed value.' });
          } else {
            const allStatic = observed.returnsUndefined
              || (observed.expressions.length > 0 && observed.expressions.every((value) => staticLiteral(value.getText(sourceFile))));
            const allowedSetContainsObservation = matcher.name === 'toContain'
              && expected !== undefined
              && !staticLiteral(expected.getText(sourceFile));
            if (allStatic && !allowedSetContainsObservation) {
              findings.push({
                file,
                line,
                test: title,
                detail: kind === 'expect-poll'
                  ? 'Poll callback returns only source constants instead of observing a changing product value.'
                  : 'Assertion tests a source literal instead of an observed product value.',
              });
            }
            if (expected && EQUALITY_MATCHERS.has(matcher.name) && observed.expressions.length > 0
              && !observed.returnsUndefined
              && observed.expressions.every((actual) => (
                normalizedNodeExpression(actual, sourceFile) === normalizedNodeExpression(expected, sourceFile)
              ))) {
              findings.push({
                file,
                line,
                test: title,
                detail: kind === 'expect-poll'
                  ? 'Poll callback and expected value read from the same source expression.'
                  : 'Assertion compares an expression with itself.',
              });
            }
          }
        }
      } else if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
        const receiver = unwrapExpression(node.expression.expression);
        if (ts.isIdentifier(receiver) && receiver.text === 'audit'
          && RUNTIME_ORACLES.has(propertyName(node.expression) ?? '')) oracleNodes.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);

  const bodySource = body.getText(sourceFile);
  const bodyLine = sourceLine(sourceFile, body);
  const cleanBody = sanitize(bodySource);
  for (const match of cleanBody.matchAll(/\|\|\s*true\b/g)) {
    findings.push({ file, line: bodyLine + lineAt(bodySource, match.index ?? 0) - 1, test: title, detail: '`|| true` can convert a failed product condition into a pass.' });
  }
  for (const match of cleanBody.matchAll(/\.catch\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const parsed = parseCall(bodySource, open);
    if (parsed && !/\bthrow\b/.test(sanitize(parsed.args[0] ?? ''))) {
      findings.push({ file, line: bodyLine + lineAt(bodySource, match.index ?? 0) - 1, test: title, detail: 'Promise rejection is swallowed by a catch handler that never throws.' });
    }
  }
  return { oracleNodes, findings };
}

export function analyzeAssertionSource(file: string, source: string): {
  declarations: DeclarationSummary[];
  findings: SourceFinding[];
} {
  const declarations: DeclarationSummary[] = [];
  const findings: SourceFinding[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = collectAssertionAliases(sourceFile);
  const declarationCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callableKind(node.expression, aliases) === 'test-helper') declarationCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const declaration of declarationCalls) {
    const declarationLine = sourceLine(sourceFile, declaration);
    if (declaration.arguments.length < 3) {
      findings.push({ file, line: declarationLine, test: '<unresolved>', detail: 'Audit declaration must have a title, evidence policy, and executable function body.' });
      continue;
    }
    const title = literalTitle(declaration.arguments[0]!.getText(sourceFile));
    const auditIds = [...title.matchAll(/\[([A-Z0-9]+(?:-[A-Z0-9]+)+)\]/g)].map((idMatch) => idMatch[1]!);
    const applicability = evidenceApplicability(declaration.arguments[1]?.getText(sourceFile));
    const body = declaration.arguments[2]!;
    const result = analyzeExpectations(file, sourceFile, body, title, aliases);
    findings.push(...result.findings);
    const unconditionalOracleCount = result.oracleNodes.filter((oracle) => !conditionallyExecuted(oracle, body)).length;
    if (result.oracleNodes.length === 0) {
      findings.push({ file, line: declarationLine, test: title, detail: 'Automated audit has no product-facing assertion or runtime oracle.' });
    } else if (unconditionalOracleCount === 0) {
      findings.push({ file, line: declarationLine, test: title, detail: 'Every product oracle is conditional; the audit can pass without executing an assertion.' });
    }
    declarations.push({
      file,
      line: declarationLine,
      title,
      auditIds,
      applicability,
      oracleCount: result.oracleNodes.length,
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
  assert(problems('await expect.poll(() => true).toBe(true);').some((detail) => detail.includes('source constants')));
  assert(problems('const result = await probe(); await expect.poll(() => result).toBe(result);').some((detail) => detail.includes('same source')));
  assert(problems('const result = await probe(); const sample = () => result; await expect.poll(sample).toEqual(result);').some((detail) => detail.includes('same source')));
  assert.deepEqual(problems('expect(await responseStatus()).toBe(200);'), []);
  assert.deepEqual(problems("await expect.poll(() => responseStatus()).toBe(200);"), []);
  assert.deepEqual(problems("const eventually = expect.poll; await eventually(() => responseStatus()).toBe(200);"), []);
  assert.deepEqual(problems('await audit.assertRuntimeHealthy();'), []);

  const importedAliases = analyzeAssertionSource('imported-alias-canary.spec.ts', `
    import { expect as verify, structuredTest as auditCase, structuredEvidence } from '../fixtures/test.js';
    auditCase('[CANARY-002] imported aliases', structuredEvidence('Retain real evidence.', 'all-projects'), async () => {
      const result = await probe();
      verify(result).toBe(result);
    });
  `);
  assert.equal(importedAliases.declarations.length, 1, 'An imported test-helper alias must remain discoverable.');
  assert(importedAliases.findings.some(({ detail }) => detail.includes('itself')), 'An imported expect alias must reject self-comparison.');

  const namespaceAliases = analyzeAssertionSource('namespace-alias-canary.spec.ts', `
    import * as fixture from '../fixtures/test.js';
    const defineAudit = fixture.structuredTest;
    const verify = fixture.expect;
    defineAudit('[CANARY-003] namespace and local aliases', fixture.structuredEvidence('Retain real evidence.', 'all-projects'), async () => {
      verify(true).toBe(true);
    });
  `);
  assert.equal(namespaceAliases.declarations.length, 1, 'Namespace and local test-helper aliases must remain discoverable.');
  assert(namespaceAliases.findings.some(({ detail }) => detail.includes('source literal')), 'A namespace-derived expect alias must reject a literal assertion.');
}

runMutationCanaries();

const repositoryRoot = process.cwd();

function auditDeclarationSource(file: string, auditId: string): string {
  const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
  const start = source.indexOf(`[${auditId}]`);
  assert.notEqual(start, -1, `${file} must retain the ${auditId} executable declaration`);
  const followingDeclarations = [
    source.indexOf('\ninteractionTest(', start + auditId.length + 2),
    source.indexOf('\nstaticTest(', start + auditId.length + 2),
    source.indexOf('\nstructuredTest(', start + auditId.length + 2),
    source.indexOf('\nstandaloneStaticTest(', start + auditId.length + 2),
  ].filter((index) => index >= 0);
  const end = followingDeclarations.length > 0 ? Math.min(...followingDeclarations) : source.length;
  return source.slice(start, end);
}

function singleSiteIsolationProblems(source: string): string[] {
  const forbidden = [
    { pattern: /\bprojectMetadata\s*\(/, detail: 'uses the comparative-only metadata reader' },
    { pattern: /\bmeta\s*\(\s*testInfo\s*\)/, detail: 'uses the comparative-only test metadata helper' },
    { pattern: /testInfo\.project\.name/, detail: 'branches on a comparative Playwright project name' },
    { pattern: /ENVIRONMENTS\.candidate/, detail: 'requests the configured candidate origin directly' },
  ] as const;
  return forbidden.filter(({ pattern }) => pattern.test(source)).map(({ detail }) => detail);
}

assert.deepEqual(singleSiteIsolationProblems('const metadata = auditMeta(testInfo);'), []);
assert(singleSiteIsolationProblems('const metadata = projectMetadata(testInfo.project.metadata);').length > 0,
  'The Single-site isolation canary must reject the comparative-only metadata reader.');
assert(singleSiteIsolationProblems("test.skip(testInfo.project.name !== 'candidate-desktop-chromium');").length > 0,
  'The Single-site isolation canary must reject exact comparative project-name gates.');
assert(singleSiteIsolationProblems('await request.get(new URL(path, ENVIRONMENTS.candidate.baseURL));').length > 0,
  'The Single-site isolation canary must reject direct candidate-origin requests.');

function runEvidenceBackedOracleCanaries(): void {
  const search = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-002');
  assert.match(search, /toHaveValue\(''\)[\s\S]*pressSequentially\(REVIEWED_CLONIDINE_SEARCH_RESULT\.query, \{ delay: 80 \}\)/, 'SEARCH-002 must record a human-visible query transition instead of an atomic fill that can disappear between video samples');
  assert.match(search, /toHaveValue\(''\)[\s\S]*waitForTimeout\(1_000\)[\s\S]*pressSequentially[\s\S]*getByRole\('status'\)[\s\S]*waitForTimeout\(1_000\)/, 'SEARCH-002 must retain stable initial and final response windows around the recorded interaction');
  assert.match(search, /scrollIntoViewIfNeeded\(\)[\s\S]*toBeInViewport\(\{ ratio: 0\.75 \}\)/, 'SEARCH-002 must make the exact named result legible in the mobile final-response evidence');
  assert.match(search, /REVIEWED_CLONIDINE_SEARCH_RESULT[\s\S]*role=\"option\"[\s\S]*\.eyebrow[\s\S]*locator\('mark'\)[\s\S]*excerptPrefix/, 'SEARCH-002 must independently assert the exact destination, category/type, highlighted term, and substantive reviewed excerpt');
  assert.doesNotMatch(search, /name: \/helper medications\.\*clonidine\/i/, 'SEARCH-002 must not collapse every promised result field into one broad accessible-name regex');

  const keyboardSearch = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-003');
  assert.match(keyboardSearch, /activeBefore[\s\S]*press\('ArrowDown'\)[\s\S]*not\.toBe\(activeBefore\)/, 'SEARCH-003 must prove ArrowDown changes selection rather than accepting a preselected no-op');
  assert.match(keyboardSearch, /navigationRequest\.url\(\)[\s\S]*expectedRequestDestination\.href[\s\S]*navigationResponse\?\.status\(\)[\s\S]*toBe\(200\)/, 'SEARCH-003 must retain exact network navigation and response assertions');

  const headerSearch = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-001');
  assert.match(headerSearch, /Open and close search from the header[\s\S]*keyboard\.press\('Escape'\)[\s\S]*headerSearch[\s\S]*toBeFocused/, 'SEARCH-001 pointer activation must close inside the recorded step and restore the exact trigger');
  assert.match(headerSearch, /Open and close search with the keyboard shortcut[\s\S]*Control\+K[\s\S]*keyboard\.press\('Escape'\)[\s\S]*headerSearch[\s\S]*toBeFocused/, 'SEARCH-001 shortcut activation must close inside the recorded step and restore the exact trigger');

  const notFound = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-007');
  const clearIndex = notFound.indexOf('await search.clear()');
  const recoveryClickIndex = notFound.indexOf('await recoveryLink.click()');
  assert(clearIndex >= 0 && recoveryClickIndex > clearIndex, 'ENV-007 must clear the results layer and reacquire the recovery link before clicking it');

  const calculator = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-006');
  assert.match(calculator, /dataset\.auditPrintRequested/, 'CALC-006 must wait for the print document’s own load-to-print signal');
  assert.match(calculator, /name: 'Taper Schedule', exact: true/, 'CALC-006 must assert the actual print H1');
  assert.match(calculator, /7-OH · 15 mg × 4\/day → jump-off at 5 mg over 30 days/, 'CALC-006 must assert the exact reviewed default print subtitle');
  assert.match(calculator, /Copy AI prompt[\s\S]*Starting dose: 15 mg × 4\/day = 60 mg\/day[\s\S]*Day 30: 2\.5 mg × 2\/day = 5 mg\/day \(jump-off\)[\s\S]*When to bring in a clinician/, 'CALC-006 must validate the complete reviewed AI-personalization prompt, not merely any copied text');
  assert.match(calculator, /window\.open = \(\(\) => null\)[\s\S]*auditFallbackPrintCount[\s\S]*toBe\('1'\)/, 'CALC-006 must prove the popup-blocked current-page print fallback exactly once');

  const meetingIntent = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-003');
  assert.match(meetingIntent, /url\.href === expectedDestination/, 'MEET-003 must intercept only the exact rendered external destination');
  assert.match(meetingIntent, /route\.fulfill\(/, 'MEET-003 must terminate the third-party request deterministically');
  assert.match(meetingIntent, /capturedDestination[\s\S]*toBe\(expectedDestination\)/, 'MEET-003 must compare the requested destination exactly');
  assert.doesNotMatch(meetingIntent, /popup\.waitForURL/, 'MEET-003 must not wait for third-party navigation completion');
  assert.match(meetingIntent, /reviewedHistory[\s\S]*ka-weekday-10-discussion[\s\S]*kqs-daily-12-midday[\s\S]*stored\.map[\s\S]*toEqual\(\[\.\.\.reviewedHistory\]/, 'MEET-003 must persist two complete independent meeting identities');
  assert.match(meetingIntent, /Remove \$\{reviewedHistory\[0\]\.name\} from history[\s\S]*Meeting history has no individual removal control[\s\S]*blocking: true[\s\S]*Clear history[\s\S]*meeting-history:v1[\s\S]*toBeNull/, 'MEET-003 must test individual removal, surface the known blocking gap, and still prove full clearing');

  const meetingFilters = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-004');
  assert.match(meetingFilters, /setTimeout\(MEET_FILTER_TOTAL_TIMEOUT_MS\)/, 'MEET-004 must retain its explicit end-to-end budget');
  assert.match(meetingFilters, /preparationDurationMs[\s\S]*toBeLessThan\(MEET_FILTER_PREPARATION_BUDGET_MS\)/, 'MEET-004 must preserve a bounded preparation partition');
  assert.match(meetingFilters, /Voices or Choices Group[\s\S]*zoom\.us\/j\/429250064[\s\S]*JFT Study[\s\S]*Basic Text Study[\s\S]*Phone Call/, 'MEET-004 must retain an independent exact NA fixture and both matching and non-matching controls');
  assert.match(meetingFilters, /expectExactMeetingDestinations\(page, expected\)[\s\S]*expectExactMeetingDestinations\(page, \[\]\)[\s\S]*expectExactMeetingDestinations\(page, baseline\)/, 'MEET-004 must prove exact inclusion, exclusion, and clear restoration');

  const smartMeetingFilters = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-005');
  assert.match(smartMeetingFilters, /4-Point Recovery — Meagan S\.[\s\S]*meetings\/9125[\s\S]*LGBTQIA\+[\s\S]*Family & Friends[\s\S]*Women[\s\S]*Spanish/, 'MEET-005 must retain an independent exact visible SMART fixture and all operable wrong-filter sentinels');
  assert.match(smartMeetingFilters, /countedButton\(audienceRow, 'Adults'\)[\s\S]*SMART’s primary Adults audience cannot be selected[\s\S]*blocking: true/, 'MEET-005 must report the reviewed feed/UI Adults mismatch as a blocking finding rather than clicking an impossible control');
  assert.match(smartMeetingFilters, /expectExactMeetingDestinations\(page, expected\)[\s\S]*expectExactMeetingDestinations\(page, \[\]\)[\s\S]*expectExactMeetingDestinations\(page, baseline\)/, 'MEET-005 must prove exact inclusion, exclusion, and clear restoration');

  const meetingStates = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-001');
  for (const exactState of ['Starting soon', 'Meeting starting', 'Live now', 'Next up']) assert.match(meetingStates, new RegExp(exactState), `MEET-001 must retain exact state ${exactState}`);
  assert.match(meetingStates, /Kratom Anonymous — Discussion[\s\S]*TIAWO — Midday[\s\S]*No KA or TIAWO meeting is live right now/, 'MEET-001 must bind every boundary to exact occurrence and no-specific-meeting identities');

  const meetingTimezones = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-002');
  assert.match(meetingTimezones, /summer[\s\S]*winter[\s\S]*America\/Chicago[\s\S]*America\/Los_Angeles[\s\S]*Europe\/London[\s\S]*Asia\/Kolkata[\s\S]*toHaveLength\(8\)/, 'MEET-002 must retain four reviewed timezones in both DST seasons');
  assert.match(meetingTimezones, /projectContext = testInfo\.project\.use[\s\S]*timezoneId: item\.timezoneId[\s\S]*ignoreHTTPSErrors: projectContext\.ignoreHTTPSErrors[\s\S]*userAgent: projectContext\.userAgent/, 'MEET-002 child contexts must preserve the project TLS and browser identity policy while changing timezone');

  const meetingDetails = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-006');
  assert.match(meetingDetails, /NA 24\/7 Online Meeting[\s\S]*558 544 927[\s\S]*247247[\s\S]*navigator\.clipboard\.readText[\s\S]*capturedDestination/, 'MEET-006 must validate exact featured identity, details, copy, and destination action');
  assert.match(meetingDetails, /It's Another Way Monday Group[\s\S]*425\) 436-6321[\s\S]*4831484[\s\S]*tel:\+14254366321[\s\S]*isTrusted/, 'MEET-006 must validate exact phone identity, access details, copied tel URL, and trusted activation');

  const calculatorSource = readFileSync(path.join(repositoryRoot, 'tests/calculators.spec.ts'), 'utf8');
  const calculatorDefaults = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-001');
  assert.match(calculatorDefaults, /substanceDefaults[\s\S]*MGM-15[\s\S]*Pseudo/, 'CALC-001 must retain an explicit vector for every offered substance');
  assert.match(calculatorDefaults, /toHaveCount\(expected\.rows\)/, 'CALC-001 must prove that each selected substance regenerates its expected schedule');
  assert.match(calculatorDefaults, /getByText\('Total daily:', \{ exact: true \}\)\.locator\('\.\.'\)[\s\S]*Total daily: \$\{expected\.total\} \(\$\{expected\.perDose\} × \$\{expected\.frequency\}\)/, 'CALC-001 must scope every default total to the dedicated labeled total surface');
  assert.match(calculatorDefaults, /Total daily: 60 mg \(20 × 3\)[\s\S]*Total daily: 80 mg \(20 × 4\)/, 'CALC-001 must prove both factors change exact dedicated totals');

  const mobileCalculator = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-004');
  assert.match(mobileCalculator, /Schedule curve \(total daily\)[\s\S]*Total duration[\s\S]*Total medication[\s\S]*Percentage taper[\s\S]*rows\[0\][\s\S]*rows\.at\(-1\)/, 'CALC-004 must bind chart, every summary, and schedule endpoints to exact reviewed values');
  assert.match(mobileCalculator, /pointer: coarse[\s\S]*15 mg — show tablet count[\s\S]*1 tablet = 15 mg[\s\S]*pageHasHorizontalOverflow/, 'CALC-004 must activate and validate the exact coarse-pointer tablet hint without overflow');

  const calculatorPersistence = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-005');
  assert.match(calculatorPersistence, /expectedSavedState[\s\S]*substance: 'pseudo'[\s\S]*perDose: 8\.5[\s\S]*customDays: 17[\s\S]*taper-calculator-v1-7oh-syn[\s\S]*toEqual\(expectedSavedState\)/, 'CALC-005 must preserve and inspect the complete reviewed 7-OH-family storage record');
  assert.match(calculatorPersistence, /BUPE_TAPER_PATH[\s\S]*toHaveValue\('8'\)[\s\S]*toHaveValue\('6'\)[\s\S]*toEqual\(expectedSavedState\)[\s\S]*audit\.goto\(TAPER_PATH\)/, 'CALC-005 must prove buprenorphine state persists independently without contaminating 7-OH-family state');
  assert.match(calculatorPersistence, /Reset form[\s\S]*Total daily: 60 mg \(15 × 4\)[\s\S]*reload[\s\S]*toContainText\('1 month'\)[\s\S]*toHaveCount\(30\)/, 'CALC-005 must validate all documented reset defaults again after reload');

  const calculatorBoundaries = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-002');
  assert.match(calculatorBoundaries, /Clear and leave the starting dose[\s\S]*toHaveValue\('15'\)[\s\S]*toHaveCount\(30\)/, 'CALC-002 must preserve the last usable plan for a blank draft and restore the committed value');
  assert.match(calculatorBoundaries, /insertText\('-'\)[\s\S]*attachJson\('malformed-native-number-state'[\s\S]*toEqual\(\{ value: '', badInput: true, valid: false \}\)[\s\S]*toHaveValue\('15'\)/, 'CALC-002 must attach and strictly assert a native bad-input state before proving safe restoration');
  assert.match(calculatorBoundaries, /explicit zero dose[\s\S]*toHaveCount\(0\)/i, 'CALC-002 must fail closed for a committed zero dose');
  assert.match(calculatorBoundaries, /Times per day', '12'[\s\S]*checkValidity\(\)/, 'CALC-002 must prove the maximum valid frequency');
  assert.match(calculatorBoundaries, /validity\.rangeOverflow[\s\S]*toHaveValue\('12'\)[\s\S]*checkValidity\(\)[\s\S]*toHaveCount\(30\)/, 'CALC-002 must prove overflow is transient, clamped, valid after blur, and backed by an exact usable plan');
  assert.match(calculatorBoundaries, /Total daily: 12\.5 mg \(12\.5 × 1\)[\s\S]*readTaperSchedule\(page\)[\s\S]*perDose: 12\.5, times: 1, total: 12\.5/, 'CALC-002 must prove decimal boundary arithmetic in both the dedicated total and first schedule row');
  assert.match(calculatorBoundaries, /Total daily: 150 mg \(12\.5 × 12\)[\s\S]*perDose: 12\.5, times: 12, total: 150/, 'CALC-002 must prove maximum-frequency arithmetic in both the dedicated total and schedule');

  const calculatorSchedule = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-003');
  assert.match(calculatorSource, /REVIEWED_7OH_PRESETS[\s\S]*label: '3 months'[\s\S]*totalSupply: '2001\.5 mg'[\s\S]*label: '2 months'[\s\S]*totalSupply: '1340\.25 mg'[\s\S]*label: '1 month'[\s\S]*totalSupply: '674\.75 mg'[\s\S]*label: '21 days'[\s\S]*totalSupply: '476\.25 mg'/, 'CALC-003 must retain all four independent preset identities and exact supplies');
  assert.match(calculatorSchedule, /REVIEWED_7OH_PRESETS[\s\S]*parseReviewedTaperRows[\s\S]*toEqual\(golden\)[\s\S]*preset\.totalSupply/, 'CALC-003 must compare every row and total supply for every reviewed preset');
  assert.match(calculatorSchedule, /const golden: TaperScheduleRow\[][\s\S]*day: 10[\s\S]*readTaperSchedule\(page\)\)\.toEqual\(golden\)/, 'CALC-003 must compare every ten-day row with an independent golden vector');
  assert.match(calculatorSchedule, /233 mg/, 'CALC-003 must preserve the independent exact supply oracle');

  const breakpointTransitions = auditDeclarationSource('tests/theme-responsive.spec.ts', 'THEME-004');
  for (const requiredControl of ['home', 'search', 'urgent-help', 'guide-navigation', 'meetings', 'appearance', 'discord']) {
    assert.match(breakpointTransitions, new RegExp(`id: '${requiredControl}'`), `THEME-004 must retain the reviewed ${requiredControl} breakpoint control`);
  }
  assert.match(breakpointTransitions, /tabIndex[\s\S]*pointerEvents[\s\S]*toBeGreaterThanOrEqual\(0\)[\s\S]*not\.toBe\('none'\)/, 'THEME-004 must prove required controls remain keyboard and pointer operable');
  assert.match(breakpointTransitions, /width < 1024[\s\S]*toBeHidden[\s\S]*width >= 520[\s\S]*width >= 720[\s\S]*width >= 760/, 'THEME-004 must assert both visible and intentionally hidden sides of every reviewed breakpoint');

  const runtimeHealth = auditDeclarationSource('tests/smoke.spec.ts', 'REL-001');
  assert.deepEqual(REPRESENTATIVE_RUNTIME_ROUTES, ['/', '/start-here/welcome', '/compounds/7-oh', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now'], 'REL-001 must retain the exact reviewed shell, guide, article, calculator, and meeting route matrix');
  assert.match(runtimeHealth, /for \(const candidatePath of REPRESENTATIVE_RUNTIME_ROUTES\)[\s\S]*audit\.assertRuntimeHealthy\(\)/, 'REL-001 must assert runtime health separately after every representative route');

  const blockedStorage = auditDeclarationSource('tests/shell-content.spec.ts', 'REL-002');
  assert.match(blockedStorage, /getItem[\s\S]*setItem[\s\S]*removeItem[\s\S]*SecurityError/, 'REL-002 must prove the storage-denial canary actually blocks reads, writes, and removal');
  assert.match(blockedStorage, /Collapse guide navigation[\s\S]*Expand guide navigation/, 'REL-002 must exercise reversible sidebar behavior while storage is blocked');
  assert.match(blockedStorage, /Total daily: 80 mg \(20 × 4\)/, 'REL-002 must bind calculator recovery to its dedicated exact total');
  assert.match(blockedStorage, /Kratom Anonymous — Discussion[\s\S]*us06web\.zoom\.us\/j\/85416304667[\s\S]*Join in \$\{expectedMeeting\.platform\}[\s\S]*context\.route\(destination[\s\S]*toHaveURL\(destination\)/, 'REL-002 must prove one independent exact meeting identity and destination remains operable while history persistence is blocked');

  const degradedDependencies = auditDeclarationSource('tests/shell-content.spec.ts', 'REL-003');
  assert.match(degradedDependencies, /google-analytics\|googletagmanager\|discord\\\.com/, 'REL-003 must retain analytics and community failure simulation');
  assert.match(degradedDependencies, /live-meeting-index\.json[\s\S]*status: 503[\s\S]*expectResponseStatus\('\/live-meeting-index\.json', 503\)/, 'REL-003 must simulate and classify an exact first-party meeting dependency failure');
  assert.match(degradedDependencies, /Checking live NA and SMART meetings…[\s\S]*virtual-na-meetings-now[\s\S]*virtual-smart-meetings-now/, 'REL-003 must prove the meeting outage settles to both reviewed recovery paths');

  const lateLayout = auditDeclarationSource('tests/performance.spec.ts', 'PERF-002');
  assert.match(lateLayout, /waitForApplicableHydration[\s\S]*pendingApplicableIslands[\s\S]*initialGeometry[\s\S]*waitForTimeout\(LAYOUT_STABILITY_OBSERVATION_MS\)[\s\S]*finalGeometry[\s\S]*lateGeometryMovementPx/, 'PERF-002 must deterministically finish applicable hydration before comparing initial and final geometry across its bounded late-shift window');
  assert.match(readFileSync(path.join(repositoryRoot, 'tests/performance.spec.ts'), 'utf8'), /LAYOUT_STABILITY_OBSERVATION_MS = 4_000/, 'PERF-002 must observe beyond common 1–2 second delayed hydration mutations');

  const securityHeaders = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-006');
  assert.match(securityHeaders, /hstsMaxAge[\s\S]*31_536_000/, 'ENV-006 must reject max-age=0 and require at least one year of HSTS protection');

  const simpleSr17 = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-007');
  assert.match(simpleSr17, /goldenProtocols: Record<7 \| 10 \| 14/, 'CALC-007 must retain exact vectors for all three documented protocol lengths');
  assert.match(simpleSr17, /readSimpleSchedule\(page\)\)\.toEqual\(goldenProtocols\[days\]\.rows\)/, 'CALC-007 must compare every rendered SR-17 row with the golden protocol');
  assert.match(calculatorSource, /readColumn[\s\S]*querySelectorAll\('p'\)[\s\S]*innerText[\s\S]*join\(' '\)/, 'CALC-007 must preserve semantic spacing when parsing discrete rendered dose paragraphs');
  assert.match(simpleSr17, /1525 mg[\s\S]*tablets: '31'/, 'CALC-007 must preserve the documented quarter-tablet rounding total and tablet-supply boundary');
  assert.match(simpleSr17, /exact half-quarter ties round upward[\s\S]*Clinical ownership must confirm[\s\S]*SR-17 half-quarter tie policy/, 'CALC-007 must expose the unapproved half-quarter tie assumption instead of presenting it as an independent clinical oracle');
  assert.match(simpleSr17, /audit\.finding\(\{[\s\S]*severity: 'P0'[\s\S]*half-quarter tie policy is not clinically approved[\s\S]*blocking: true/, 'CALC-007 must emit a P0 blocking finding until clinical ownership approves the half-quarter tie policy');

  const noResultSearch = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-005');
  assert.match(noResultSearch, /qzxvplmwrtyknfdh[\s\S]*no pages matched/i, 'SEARCH-005 must use one absent token that cannot OR-match ordinary indexed words');
  assert.doesNotMatch(noResultSearch, /no-such-medication/, 'SEARCH-005 must not label a query containing real indexed words as impossible');
  assert.match(noResultSearch, /Recover with a known treatment query[\s\S]*fill\('clonidine'\)[\s\S]*helper medications[\s\S]*REVIEWED_CLONIDINE_SEARCH_RESULT\.href[\s\S]*toBeFocused[\s\S]*keyboard\.press\('Enter'\)[\s\S]*expectedDestination[\s\S]*toHaveURL[\s\S]*toBeVisible/, 'SEARCH-005 must operate the exact reviewed fragment destination, verify keyboard navigation, and prove the target section is visible');

  const searchFilters = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-004');
  assert.match(searchFilters, /selectOption\('start-here'\)[\s\S]*selectOption\('Guide'\)/, 'SEARCH-004 must use the explicit reviewed topic/type vector');
  assert.match(searchFilters, /filteredEvidence\.every[\s\S]*\/start-here\/[\s\S]*Start Here · Guide[\s\S]*7-oh-withdrawal-guide/, 'SEARCH-004 must prove every narrowed result matches both filters and retain an independent expected result');
  assert.match(searchFilters, /toBeLessThan\(unfilteredHrefs\.length\)[\s\S]*reload[\s\S]*Result type[\s\S]*toHaveValue\('Guide'\)[\s\S]*reloadedEvidence[\s\S]*toEqual\(filteredEvidence\)/, 'SEARCH-004 must prove narrowing and preserve both controls plus exact result semantics after reload');
  assert.doesNotMatch(searchFilters, /options\.find|option !== 'All types'/, 'SEARCH-004 must not derive its expected filter from the product options');

  const arithmetic = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-009');
  assert.match(arithmetic, /published buprenorphine table[\s\S]*two-day 7-OH[\s\S]*explicit zero jump-off/, 'CALC-009 must retain representative, minimum-duration, and explicit-zero black-box cases');
  assert.match(arithmetic, /expect\(rows\)\.toEqual\(golden\)/, 'CALC-009 must compare deployed output to independent constants');
  assert.match(arithmetic, /schedule-stop-row[\s\S]*Stop\. Taper complete/, 'CALC-009 must prove the explicit-zero stop response');

  const routeInventory = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-002');
  assert.match(routeInventory, /mapWithConcurrency\(CANDIDATE_HTML_ROUTES/, 'ENV-002 must issue a bounded probe for every declared candidate route');
  assert.match(routeInventory, /response\.status\(\)[\s\S]*toBe\(200\)/, 'ENV-002 must require successful HTML responses');
  assert.match(routeInventory, /canonical\.origin[\s\S]*ENVIRONMENTS\.production\.baseURL[\s\S]*canonical\.pathname[\s\S]*route\.path/, 'ENV-002 must prove the exact public canonical origin and route');

  const betaIndexing = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-005');
  assert.match(betaIndexing, /mapWithConcurrency\(CANDIDATE_HTML_ROUTES, 8[\s\S]*betaRouteLedger/, 'ENV-005 must inspect indexing policy on the complete reviewed route matrix');
  assert.match(betaIndexing, /robotContents\.length !== 1[\s\S]*deploymentRole === 'preview'[\s\S]*includes\('noindex'\)[\s\S]*deploymentRole === 'production'[\s\S]*canonicalHrefs\.length !== 1[\s\S]*routeCanonical\.pathname[\s\S]*route\.path/, 'ENV-005 must require role-correct indexing and one exact production canonical on every reviewed route');
  assert.match(betaIndexing, /betaIndexingProblems[\s\S]*toEqual\(\[\]\)/, 'ENV-005 must fail on any route-level indexing-policy problem');

  const internalLinks = auditDeclarationSource('tests/content-system.spec.ts', 'CONTENT-003');
  assert.match(internalLinks, /extractHtmlTagAttributes\(html, 'a', 'href'\)/, 'CONTENT-003 must crawl rendered anchor hrefs instead of replaying only the registry');
  assert.match(internalLinks, /context\.newPage\(\)[\s\S]*locator\('a\[href\]'\)\.evaluateAll[\s\S]*hydratedInternalReferences/, 'CONTENT-003 must extract the post-hydration anchor graph in the configured certificate-aware browser context');
  assert.match(internalLinks, /astro-island\[ssr\][\s\S]*matchMedia[\s\S]*applicableUnhydratedIslands[\s\S]*applicableUnhydratedIslands !== 0/, 'CONTENT-003 must wait for every applicable Astro island instead of sampling an arbitrary hydration delay');
  assert.match(internalLinks, /serverInternalReferences[\s\S]*hydratedInternalReferences[\s\S]*internalReferences = \[\.\.\.serverInternalReferences, \.\.\.hydratedInternalReferences\]/, 'CONTENT-003 must probe the union of server and hydrated destinations');
  assert.match(internalLinks, /hydratedInternalReferences\.length[\s\S]*CANDIDATE_HTML_ROUTES\.length \* 3/, 'CONTENT-003 must fail if the hydrated link graph silently collapses');
  assert.match(internalLinks, /internalReferences\.length[\s\S]*CANDIDATE_HTML_ROUTES\.length \* 3/, 'CONTENT-003 must fail if anchor extraction silently collapses');
  assert.match(internalLinks, /missingFragments[\s\S]*toEqual\(\[\]\)/, 'CONTENT-003 must require every rendered fragment target to exist');

  const documentLandmarks = auditDeclarationSource('tests/content-system.spec.ts', 'CONTENT-001');
  assert.match(documentLandmarks, /landmarks:[\s\S]*header:[\s\S]*main:[\s\S]*footer:[\s\S]*nav:/, 'CONTENT-001 must inspect each required landmark class');
  assert.match(documentLandmarks, /querySelectorAll\('body > header'\)[\s\S]*querySelectorAll\('body > footer'\)/, 'CONTENT-001 must count the site-level landmarks without treating valid document headers or section footers as duplicate site chrome');
  assert.doesNotMatch(documentLandmarks, /body > (?:header|footer), (?:header|footer)/, 'CONTENT-001 must not use a broad descendant selector for site-level landmark cardinality');
  assert.match(documentLandmarks, /landmarks\.header[\s\S]*toBe\(1\)[\s\S]*landmarks\.main[\s\S]*toBe\(1\)[\s\S]*landmarks\.footer[\s\S]*toBe\(1\)[\s\S]*landmarks\.nav[\s\S]*toBeGreaterThan\(0\)/, 'CONTENT-001 must reject missing or duplicate required landmarks');
  assert.match(documentLandmarks, /if \(route === '\/'\) await audit\.checkpoint\('representative-document-outline'\)/, 'CONTENT-001 must retain a named homepage checkpoint before later route findings so baseline review can preserve, rather than erase, unresolved deterministic truth');

  const denseSurfaces = auditDeclarationSource('tests/content-system.spec.ts', 'CONTENT-006');
  for (const reviewedRoute of ['/resources/7-oh-taper-calculator', '/pharmacology/chemical-structures', '/virtual-na-meetings-now', '/about/changelog']) {
    assert.match(denseSurfaces, new RegExp(reviewedRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `CONTENT-006 must retain reviewed dense route ${reviewedRoute}`);
  }
  assert.match(denseSurfaces, /summary cards[\s\S]*exactCount: 3[\s\S]*reviewed structure figures[\s\S]*exactCount: 12/, 'CONTENT-006 must bind exact repeated-surface counts rather than accepting arbitrary content');
  assert.match(denseSurfaces, /widths = \[320, 768, 1440\][\s\S]*expectedCoverage[\s\S]*toHaveLength\(12\)[\s\S]*toEqual\(expectedCoverage\)/, 'CONTENT-006 must produce the complete reviewed route-by-width matrix');

  const contentRendering = readFileSync(path.join(repositoryRoot, 'tests/visual-regression.spec.ts'), 'utf8');
  const contentRenderingDeclaration = auditDeclarationSource('tests/visual-regression.spec.ts', 'CONTENT-002');
  for (const primitive of ['prose paragraphs', 'ordered or unordered list items', 'medical callout blockquote', 'schedule table', 'inline or block code', 'native disclosure']) {
    assert.match(contentRendering, new RegExp(primitive), `CONTENT-002 must retain the ${primitive} contract`);
  }
  assert.match(contentRendering, /\.open = true/, 'CONTENT-002 must inspect disclosure content in its expanded state');
  assert.match(contentRendering, /scrollWidth[\s\S]*clientWidth[\s\S]*scrollHeight[\s\S]*clientHeight/, 'CONTENT-002 must measure both horizontal and vertical content clipping');
  assert.match(contentRendering, /article\.prose-recovery[\s\S]*:is\(ol, ul\) > li/, 'CONTENT-002 must inspect article prose without treating breadcrumb truncation as content loss');
  assert.match(contentRendering, /measuredLineClamp[\s\S]*scrollHeight[\s\S]*clientHeight[\s\S]*measuredEllipsis[\s\S]*scrollWidth[\s\S]*clientWidth/, 'CONTENT-002 must reject line clamps and ellipses only when geometry proves content loss');
  assert.match(contentRendering, /attachJson\(`content-primitives-\$\{contract\.path[\s\S]*evidence\.push[\s\S]*attachJson\('content-primitive-clipping-evidence'/, 'CONTENT-002 must retain per-route measurements even if a later inspection aborts the aggregate');
  assert.match(contentRendering, /horizontalBoundary = scrollOwner \?\? element[\s\S]*owning horizontal scroller is clipped by an outer ancestor/, 'CONTENT-002 must not let a clipped or offscreen scroll owner mask content loss');
  assert.match(contentRendering, /result\.issues[\s\S]*toEqual\(\[\]\)/, 'CONTENT-002 must fail when any primitive has a clipping issue');
  assert.match(contentRenderingDeclaration, /Inspect critical content primitives[\s\S]*assertRepresentativeContentPrimitives/, 'CONTENT-002 must execute the primitive clipping contract from the browser audit');

  const assets = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-008');
  assert.match(assets, /REVIEWED_SEARCH_RECORD_COUNT = 88[\s\S]*expectedRootKeys = \['index', 'pageCount', 'recordCount', 'version'\]/, 'ENV-008 must bind the search endpoint to the reviewed root schema and document count');
  assert.match(assets, /expectedFieldIds[\s\S]*title: 0[\s\S]*content: 4[\s\S]*records\.forEach/, 'ENV-008 must validate the reviewed search fields and every stored record');
  assert.match(assets, /page:medications-supplements\/helper-meds[\s\S]*Clonidine[\s\S]*#clonidine/, 'ENV-008 must retain an exact known search-content sentinel');
  assert.match(assets, /na\.forEach[\s\S]*smart\.forEach[\s\S]*validateNaMeeting\(payload\.featuredNa/, 'ENV-008 must validate every NA and SMART record plus the featured fallback');
  assert.match(assets, /extractFirstPartyAssetReferences[\s\S]*htmlAssets\.length/, 'ENV-008 must discover assets from every candidate route document');
  assert.match(assets, /extractCssReferences[\s\S]*nestedCssAssets/, 'ENV-008 must traverse first-party assets referenced by CSS');
  assert.match(assets, /expectedContentType[\s\S]*toMatch\(expectedContentType\)/, 'ENV-008 must enforce extension-appropriate response types');

  const fullMetadata = auditDeclarationSource('tests/contracts.spec.ts', 'SEO-001');
  assert.match(fullMetadata, /\['candidate', 'production'\][\s\S]*CANDIDATE_HTML_ROUTES\.flatMap[\s\S]*resolveEnvironmentPath\('production'/, 'SEO-001 must derive a full two-environment matrix from the reviewed canonical route inventory');
  assert.match(fullMetadata, /expected exactly one \$\{name\}[\s\S]*og:title differs from title[\s\S]*og:url differs from canonical[\s\S]*twitter:title differs from title[\s\S]*twitter:image differs from og:image[\s\S]*preview robots policy does not include noindex[\s\S]*production robots policy does not allow indexing[\s\S]*canonicalUrl\.pathname[\s\S]*entry\.path/, 'SEO-001 must bind complete metadata, role-aware indexing semantics, and canonical identity for every route');
  assert.match(fullMetadata, /metadataProblems[\s\S]*toEqual\(\[\]\)/, 'SEO-001 must fail on any full-inventory metadata problem');

  const sitemap = auditDeclarationSource('tests/contracts.spec.ts', 'SEO-002');
  assert.match(sitemap, /unexpected = \[\.\.\.sitemapPaths\][\s\S]*duplicatePaths[\s\S]*legacyAliasesInSitemap/, 'SEO-002 must reject unexpected or duplicate canonical paths and every reviewed legacy alias');
  assert.match(sitemap, /mapWithConcurrency\(locations, 8[\s\S]*response\.status\(\) !== 200[\s\S]*canonicals\.length !== 1[\s\S]*canonical\.pathname[\s\S]*sitemapUrl\.pathname/, 'SEO-002 must request every sitemap location and prove one matching canonical');
  assert.match(sitemap, /missing[\s\S]*toEqual\(\[\]\)[\s\S]*unexpected[\s\S]*toEqual\(\[\]\)[\s\S]*locationProblems[\s\S]*toEqual\(\[\]\)/, 'SEO-002 must require exact set equality and healthy canonical responses');

  const crisisLayout = auditDeclarationSource('tests/shell-content.spec.ts', 'CRISIS-001');
  assert.match(crisisLayout, /for \(const expected of CRISIS_ACTIONS\)[\s\S]*toHaveAttribute\('href', expected\.href\)/, 'CRISIS-001 must validate every reviewed action and exact destination');
  assert.match(crisisLayout, /geometry\.height[\s\S]*toBeGreaterThanOrEqual\(44\)/, 'CRISIS-001 must preserve touch-target geometry assertions');

  const crisisActions = auditDeclarationSource('tests/smoke.spec.ts', 'CRISIS-002');
  assert.match(crisisActions, /for \(const expected of CRISIS_ACTIONS\)[\s\S]*expected\.href/, 'CRISIS-002 must retain the complete exact crisis-action matrix');
  assert.match(crisisActions, /serverHtml[\s\S]*CRISIS_MEETING_FALLBACK/, 'CRISIS-002 must prove the deterministic same-site meeting fallback');

  const keyboard = auditDeclarationSource('tests/accessibility.spec.ts', 'A11Y-002');
  for (const requiredJourney of ['Operate guide navigation by keyboard', 'Edit the taper calculator by keyboard', 'Expand a disclosure by keyboard', 'Filter meetings by keyboard']) {
    assert.match(keyboard, new RegExp(requiredJourney), `A11Y-002 must retain: ${requiredJourney}`);
  }
  assert.doesNotMatch(keyboard, /\.fill\(/, 'A11Y-002 must not substitute pointer-style direct form filling for keyboard entry');
  assert.match(keyboard, /attachJson\('skip-link-entry-evidence'[\s\S]*targetMatchesFragment[\s\S]*targetInViewport[\s\S]*focusWithinMain[\s\S]*focusedInViewport[\s\S]*focusedUnoccluded[\s\S]*focusedUsesFocusVisible/, 'A11Y-002 must attach fragment, sequential-entry, visibility, occlusion, and focus-indicator evidence before asserting it');
  assert.match(keyboard, /clonidine[\s\S]*ArrowDown[\s\S]*activeHref[\s\S]*helper-meds#clonidine[\s\S]*keyboard\.press\('Enter'\)[\s\S]*toHaveURL[\s\S]*Helper Medications[\s\S]*#clonidine[\s\S]*toBeVisible/, 'A11Y-002 must keyboard-select the exact reviewed search result and prove its actual page identity and fragment target');
  assert.match(keyboard, /a\[href="\/start-here\/welcome"\][\s\S]*tabUntilFocused[\s\S]*keyboard\.press\('Enter'\)[\s\S]*toHaveURL\(\/\\\/start-here\\\/welcome/, 'A11Y-002 must activate the exact guide destination instead of merely toggling the shell');
  assert.match(keyboard, /toHaveLength\(12\)/, 'A11Y-002 must retain two evidence checkpoints for every critical keyboard task');

  const reducedMotion = auditDeclarationSource('tests/accessibility.spec.ts', 'A11Y-005');
  assert.match(reducedMotion, /ancestor::astro-island\[1\][\s\S]*not\.toHaveAttribute\('ssr'/, 'A11Y-005 must wait for the stateful support island before inspecting computed motion');
  assert.match(reducedMotion, /locator\('body \*'\)\.evaluateAll[\s\S]*getComputedStyle[\s\S]*animationName[\s\S]*transitionProperty/, 'A11Y-005 must enumerate computed animation and transition state across visible elements');
  assert.match(reducedMotion, /ACTIVE_MOTION_THRESHOLD_SECONDS = 0\.001[\s\S]*animationDurations[\s\S]*transitionDurations/, 'A11Y-005 must distinguish the 0.01ms reduced-motion reset from perceivable active motion');
  assert.match(reducedMotion, /activeAnimations[\s\S]*toEqual\(\[\]\)[\s\S]*activeMotionTransitions[\s\S]*toEqual\(\[\]\)/, 'A11Y-005 must reject every active reduced-motion animation or motion transition');
  assert.match(reducedMotion, /aria-live="polite"[\s\S]*Live now · 7-OH \/ kratom[\s\S]*Join live/, 'A11Y-005 must bind status semantics to exact text and action rather than color');

  const drawer = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-001');
  assert.match(drawer, /mobile-guide-focusable-ledger[\s\S]*Shift\+Tab[\s\S]*mobile-guide-focus-cycle[\s\S]*next\.index[\s\S]*not\.toBe\(origin\.index\)[\s\S]*forwardWrap[\s\S]*reverseWrap/, 'NAV-001 must prove distinct movement plus forward and reverse boundary wrapping without an O(n) paced key loop');
  for (const closeMethod of ['Close with Escape', 'Close with the named close control', 'Close with the backdrop']) {
    assert.match(drawer, new RegExp(closeMethod), `NAV-001 must retain: ${closeMethod}`);
  }

  const mobileCategories = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-002');
  assert.match(mobileCategories, /REVIEWED_GUIDE_CATEGORIES[\s\S]*expectedCategories[\s\S]*toEqual\(expectedCategories\)/, 'NAV-002 must compare exact reviewed category labels, order, and destinations');
  assert.match(mobileCategories, /sleep-recovery[\s\S]*dopamine-recovery[\s\S]*loggedGet[\s\S]*status\(\) === 200/, 'NAV-002 must prove exact current/sibling paths and load every reviewed category destination');
  assert.doesNotMatch(mobileCategories, /expect\(categories\.length\)\.toBe\(10\)/, 'NAV-002 must not accept an arbitrary set of ten categories');

  const sidebar = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-003');
  assert.match(sidebar, /data-audit-reading-anchor[\s\S]*desktop-sidebar-reading-anchor[\s\S]*after\.id[\s\S]*before\.id[\s\S]*after\.inViewport[\s\S]*after\.top - before\.top/, 'NAV-003 must preserve a visible semantic reading anchor instead of comparing brittle raw scroll coordinates');

  const toc = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-005');
  assert.match(toc, /alignmentSamples[\s\S]*waitForTimeout\(100\)[\s\S]*toc-smooth-scroll-alignment[\s\S]*settled\.top[\s\S]*settled\.active[\s\S]*location/, 'NAV-005 must sample smooth scrolling until both sticky alignment and active TOC state settle');

  const breadcrumb = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-004');
  assert.match(breadcrumb, /Breadcrumb[\s\S]*Compounds[\s\S]*toHaveAttribute\('href', '\/compounds'\)[\s\S]*parent\.click\(\)[\s\S]*toHaveText\('Compounds'\)/, 'NAV-004 must activate the exact reviewed parent crumb and assert destination identity');
  assert.match(breadcrumb, /Copy a link to this page[\s\S]*navigator\.clipboard\.readText[\s\S]*copy-announce[\s\S]*(?:Page link|Link) copied to clipboard/, 'NAV-004 must assert both clipboard output and accessible confirmation');

  const homepage = auditDeclarationSource('tests/smoke.spec.ts', 'HOME-001');
  assert.match(homepage, /REVIEWED_HOME_PRIMARY_ACTIONS[\s\S]*action\.label[\s\S]*toHaveAttribute\('href', action\.path\)[\s\S]*link\.click\(\)[\s\S]*action\.expectedH1/, 'HOME-001 must operate every environment-specific reviewed primary action and exact destination identity');
  assert.doesNotMatch(homepage, /startingPaths|\.find\(\(\{ href \}\)|withdrawal\|quit\|medication\|meeting\|support\|guide\|calculator/, 'HOME-001 must not derive expected actions from broad product-text regexes');

  const categoryIndex = auditDeclarationSource('tests/shell-content.spec.ts', 'NAV-008');
  assert.match(categoryIndex, /START_HERE_CATEGORY_INDEX_CONTRACT[\s\S]*reportedPageCount[\s\S]*groupCount[\s\S]*lastUpdated[\s\S]*summary[\s\S]*visible/, 'NAV-008 must collect count, grouping, reviewed metadata, summary, and visibility evidence');
  assert.match(categoryIndex, /evaluateCategoryIndexContract[\s\S]*issues[\s\S]*toEqual\(\[\]\)/, 'NAV-008 must reject every exact category-index contract issue');
  assert.doesNotMatch(categoryIndex, /toBeGreaterThanOrEqual\(8\)/, 'NAV-008 must not accept an arbitrary set of eight healthy routes');

  const pageAudit = readFileSync(path.join(repositoryRoot, 'tests/page-audit.spec.ts'), 'utf8');
  const pageInspection = readFileSync(path.join(repositoryRoot, 'fixtures/test.ts'), 'utf8');
  assert.match(pageAudit, /expectedPathname[\s\S]*approvedCanonicalOrigins/, 'PAGE-* must compute exact URL and approved canonical-origin evidence');
  assert.match(pageAudit, /routeContractIssues[\s\S]*route-identity-evidence/, 'PAGE-* must attach reviewed identity and structural contract issues before asserting them');
  assert.match(pageAudit, /evaluateRouteContract[\s\S]*routeContractIssues[\s\S]*toEqual\(\[\]\)/, 'PAGE-* must reject every issue returned by the independent route contract');
  assert.match(pageAudit, /page-geometry-evidence[\s\S]*horizontalOverflowCandidateCount/, 'PAGE-* must retain actionable page geometry when overflow assertions fail');
  assert.match(pageAudit, /pageAuditApplicability\(route\.path\)[\s\S]*staticEvidence\([\s\S]*applicability\)/, 'PAGE-* runtime annotations must use the same route-specific applicability oracle as registry generation');
  assert.match(pageInspection, /nearestScrollOwnerFor[\s\S]*selectorMatchCount[\s\S]*classifyHorizontalOverflowCandidates/, 'Page inspection must capture selector and scroll-owner diagnostics before bounded classification');
  assert(pageAudit.indexOf("attachJson('page-geometry-evidence'") < pageAudit.indexOf("audit.step('Assert meaningful page semantics'"), 'PAGE-* must attach geometry before assertions can abort the test');
  assert(pageAudit.indexOf("attachJson('route-identity-evidence'") < pageAudit.indexOf("audit.step('Assert meaningful page semantics'"), 'PAGE-* must attach route identity before assertions can abort the test');
}

runEvidenceBackedOracleCanaries();

function validRouteEvidence(route: CandidateRoute): RouteStructureEvidence {
  const declared = CANDIDATE_HTML_ROUTES.map(({ path }) => path);
  const children = declared.filter((path) => path.startsWith(`${route.path}/`) && !path.slice(route.path.length + 1).includes('/'));
  const mainInternalPaths = route.kind === 'category'
    ? children
    : route.kind === 'home'
      ? ['/start-here/welcome', '/medications-supplements/helper-meds', '/resources/taper-calculator', '/about/this-site']
      : route.path === '/resources/taper-calculator'
        ? [
            '/resources/7-oh-taper-calculator',
            '/resources/kratom-leaf-taper-calculator',
            '/resources/sr-17-taper-calculator',
            '/resources/suboxone-taper-calculator',
          ]
        : route.path === '/sitemap'
          ? declared.filter((path) => !HUMAN_SITEMAP_EXCLUDED_PATHS.includes(path as typeof HUMAN_SITEMAP_EXCLUDED_PATHS[number]))
          : ['/start-here/welcome'];
  return {
    actualPathname: route.path,
    canonical: `https://quitting7oh.org${route.path}`,
    canonicalPathname: route.path,
    canonicalOrigin: 'https://quitting7oh.org',
    title: `${route.expectedTitle} · quitting7oh.org`,
    h1Text: route.expectedH1,
    mainH1Count: 1,
    mainCharacters: 1_000,
    visibleArticleCount: 1,
    articleCharacters: 800,
    proseBlockLengths: [80, 120, 80],
    sectionHeadingCount: 6,
    mainInternalPaths,
    enabledFormControlCount: 2,
    searchInputs: [{ accessibleName: 'Search all pages', disabled: false }],
    urgentLinkCount: 2,
  };
}

function routeContext(route: CandidateRoute, environment: 'candidate' | 'production' = 'candidate'): RouteContractContext {
  const declared = CANDIDATE_HTML_ROUTES.map(({ path }) => path);
  return {
    environment,
    expectedPathname: route.path,
    approvedCanonicalOrigins: ['https://quitting7oh.org'],
    expectedChildPaths: declared.filter((path) => path.startsWith(`${route.path}/`) && !path.slice(route.path.length + 1).includes('/')),
    declaredRoutePaths: declared,
  };
}

function rawOverflowCandidate(overrides: Partial<RawHorizontalOverflowCandidate> = {}): RawHorizontalOverflowCandidate {
  return {
    selector: 'main > table',
    selectorMatchCount: 1,
    tagName: 'table',
    text: 'reviewed table evidence',
    left: 0,
    right: 120,
    width: 120,
    clientWidth: 120,
    scrollWidth: 120,
    overflowX: 'visible',
    position: 'static',
    containedByScrollOwner: false,
    nearestScrollOwner: null,
    ...overrides,
  };
}

function runPageOracleMutationCanaries(): void {
  const representatives = new Map<CandidateRouteKind, CandidateRoute>();
  for (const route of CANDIDATE_HTML_ROUTES) {
    if (!representatives.has(route.kind)) representatives.set(route.kind, route);
    assert(route.expectedH1.trim().length > 0, `${route.path} must declare a reviewed H1`);
    assert(route.expectedTitle.trim().length > 0, `${route.path} must declare a reviewed title`);
  }
  assert.equal(representatives.size, 8, 'Every route kind must have a mutation-canary representative');
  for (const route of representatives.values()) {
    const genericShell = {
      ...validRouteEvidence(route),
      title: 'Generic recovery page · quitting7oh.org',
      h1Text: 'Generic recovery page',
    };
    assert(evaluateRouteContract(route, genericShell, routeContext(route)).length > 0, `${route.kind} must reject a self-canonical generic shell`);
  }

  const renamedArticle = CANDIDATE_HTML_ROUTES.find(({ path }) => path === '/post-acute/7-oh-recovery-timeline');
  assert(renamedArticle);
  assert.deepEqual(evaluateRouteContract(renamedArticle, validRouteEvidence(renamedArticle), routeContext(renamedArticle)), [], 'Reviewed renamed H1 must pass without slug guessing');

  assert.equal(resolveEnvironmentPath('production', '/about/acknowledgments'), null,
    'A candidate-only page must not be fabricated from a legacy route that served the production home shell.');
  assert.equal(resolveEnvironmentPath('production', '/medications-supplements/helper-meds'), '/other-tools/helper-meds',
    'The helper-medication audit must use the production route observed after canonical redirect resolution.');

  const withdrawalRoute = CANDIDATE_HTML_ROUTES.find(({ path }) => path === '/start-here/7-oh-withdrawal-help');
  assert(withdrawalRoute);
  const productionWithdrawalEvidence = {
    ...validRouteEvidence(withdrawalRoute),
    h1Text: 'You’re in Withdrawal Right Now',
    title: 'You’re in Withdrawal Right Now · quitting7oh.org',
  };
  assert.deepEqual(
    evaluateRouteContract(withdrawalRoute, productionWithdrawalEvidence, routeContext(withdrawalRoute, 'production')),
    [],
    'The exact observed production crisis-page identity must remain a reviewed baseline alias.',
  );
  assert(
    evaluateRouteContract(withdrawalRoute, productionWithdrawalEvidence, routeContext(withdrawalRoute, 'candidate'))
      .some((issue) => issue.includes('reviewed identity')),
    'A production-only identity must not weaken the candidate redesign oracle.',
  );

  const welcomeArticle = CANDIDATE_HTML_ROUTES.find(({ path }) => path === '/start-here/welcome');
  assert(welcomeArticle);
  const welcomeShell = { ...validRouteEvidence(welcomeArticle), visibleArticleCount: 0, articleCharacters: 0, proseBlockLengths: [] };
  assert(evaluateRouteContract(welcomeArticle, welcomeShell, routeContext(welcomeArticle)).length > 0, 'A correctly titled Welcome shell must still fail article structure');
  const sparseWelcome = {
    ...validRouteEvidence(welcomeArticle),
    mainCharacters: 121,
    articleCharacters: 121,
    proseBlockLengths: [61, 1],
    sectionHeadingCount: 0,
    mainInternalPaths: [],
  };
  assert(
    evaluateRouteContract(welcomeArticle, sparseWelcome, routeContext(welcomeArticle)).length > 0,
    'An exact-title article with sparse, degenerate prose must not pass as complete content.',
  );

  const searchRoute = CANDIDATE_HTML_ROUTES.find(({ kind }) => kind === 'search');
  assert(searchRoute);
  const disabledSearch = { ...validRouteEvidence(searchRoute), searchInputs: [{ accessibleName: 'Search', disabled: true }] };
  assert(evaluateRouteContract(searchRoute, disabledSearch, routeContext(searchRoute)).some((issue) => issue.includes('search input')), 'Disabled search controls must fail');

  const categoryRoute = CANDIDATE_HTML_ROUTES.find(({ kind }) => kind === 'category');
  assert(categoryRoute);
  const categoryContext = routeContext(categoryRoute);
  const duplicateRecoveryLinks = { ...validRouteEvidence(categoryRoute), mainInternalPaths: [categoryContext.expectedChildPaths[0]!, categoryContext.expectedChildPaths[0]!] };
  assert(evaluateRouteContract(categoryRoute, duplicateRecoveryLinks, categoryContext).some((issue) => issue.includes('omits')), 'Duplicate recovery links must not satisfy a category directory');
  const oneMissingCategoryChild = {
    ...validRouteEvidence(categoryRoute),
    mainInternalPaths: categoryContext.expectedChildPaths.slice(0, -1),
  };
  assert(evaluateRouteContract(categoryRoute, oneMissingCategoryChild, categoryContext).some((issue) => issue.includes('omits 1 reviewed immediate child route')), 'A category must fail when even one reviewed child becomes undiscoverable');

  const sitemapRoute = CANDIDATE_HTML_ROUTES.find(({ path }) => path === '/sitemap');
  assert(sitemapRoute);
  const sitemapContext = routeContext(sitemapRoute);
  const completeSitemap = validRouteEvidence(sitemapRoute);
  assert.deepEqual(evaluateRouteContract(sitemapRoute, completeSitemap, sitemapContext), [], 'The reviewed human-sitemap inventory must pass exactly');
  const oneMissingSitemapDestination = {
    ...completeSitemap,
    mainInternalPaths: completeSitemap.mainInternalPaths.slice(0, -1),
  };
  assert(evaluateRouteContract(sitemapRoute, oneMissingSitemapDestination, sitemapContext).some((issue) => issue.includes('site map omits 1 reviewed destination')), 'The human site map must fail when even one non-exempt reviewed route disappears');

  const validCategoryIndexEvidence = {
    reportedPageCount: START_HERE_CATEGORY_INDEX_CONTRACT.items.length,
    groupCount: START_HERE_CATEGORY_INDEX_CONTRACT.expectedGroupCount,
    items: START_HERE_CATEGORY_INDEX_CONTRACT.items.map((item) => ({
      ...item,
      summary: 'A reviewed category-card summary with enough detail to orient a reader.',
      visible: true,
    })),
  };
  assert.deepEqual(
    evaluateCategoryIndexContract(START_HERE_CATEGORY_INDEX_CONTRACT, validCategoryIndexEvidence),
    [],
    'The exact reviewed category inventory must pass.',
  );
  const arbitraryHealthyRoutes = {
    ...validCategoryIndexEvidence,
    items: validCategoryIndexEvidence.items.map((item, index) => ({
      ...item,
      path: `/start-here/arbitrary-published-route-${index}`,
    })),
  };
  assert(
    evaluateCategoryIndexContract(START_HERE_CATEGORY_INDEX_CONTRACT, arbitraryHealthyRoutes)
      .some((issue) => issue.includes('do not match the inventory')),
    'Eight healthy but wrong category destinations must fail the reviewed inventory.',
  );
  const staleCategoryMetadata = {
    ...validCategoryIndexEvidence,
    items: validCategoryIndexEvidence.items.map((item, index) => index === 0
      ? { ...item, lastUpdated: '1999-01-01' }
      : item),
  };
  assert(
    evaluateCategoryIndexContract(START_HERE_CATEGORY_INDEX_CONTRACT, staleCategoryMetadata)
      .some((issue) => issue.includes('do not match the inventory')),
    'A stale or substituted category update date must fail the reviewed metadata contract.',
  );

  for (const contract of REVIEWED_HOME_SUPPORT_STATES) {
    const validSupportState = {
      id: contract.id,
      at: contract.at,
      textLines: [...contract.requiredTextLines],
      actions: contract.actions.map((action) => ({ ...action })),
    };
    assert.deepEqual(evaluateHomeSupportStateContract(contract, validSupportState), [], `${contract.id} support state must pass its exact contract`);
    const arbitrarySupportLinks = {
      ...validSupportState,
      actions: validSupportState.actions.map((action, index) => index === 0
        ? { ...action, href: 'https://example.invalid/arbitrary-support' }
        : action),
    };
    assert(
      evaluateHomeSupportStateContract(contract, arbitrarySupportLinks).length > 0,
      `${contract.id} must reject a healthy-looking but substituted support destination`,
    );
    const appendedArbitraryAction = {
      ...validSupportState,
      actions: [...validSupportState.actions, {
        accessibleName: 'Unreviewed support shortcut',
        href: 'https://example.invalid/unreviewed',
        target: '_blank',
        rel: 'noopener noreferrer',
      }],
    };
    assert(
      evaluateHomeSupportStateContract(contract, appendedArbitraryAction)
        .some((issue) => issue.includes('instead of exactly')),
      `${contract.id} must reject extra irrelevant actions even when every reviewed action remains present`,
    );
    const wrongClockSemantics = {
      ...validSupportState,
      textLines: validSupportState.textLines.slice(1),
    };
    assert(
      evaluateHomeSupportStateContract(contract, wrongClockSemantics).some((issue) => issue.includes('omits exact text line')),
      `${contract.id} must reject missing clock/state semantics`,
    );
  }

  const validDarkFrame = {
    dark: true,
    mode: 'dark',
    background: 'rgb(29, 25, 22)',
    foreground: 'rgb(240, 237, 229)',
    readyState: 'interactive',
  };
  assert.deepEqual(evaluateDarkThemePaintContract(validDarkFrame), [], 'A genuine dark first frame with readable contrast must pass');
  assert(
    evaluateDarkThemePaintContract({ ...validDarkFrame, dark: false, mode: 'light', background: 'rgb(255, 255, 255)' }).length >= 2,
    'A light first frame followed by dark hydration must fail the first-paint contract',
  );

  const narrowHeaderContract = REVIEWED_HEADER_BREAKPOINTS.find(({ width }) => width === 360);
  assert(narrowHeaderContract);
  const headerControlsById = new Map(REVIEWED_HEADER_CONTROLS.map((control) => [control.id, control]));
  const validNarrowHeader = {
    width: narrowHeaderContract.width,
    controls: narrowHeaderContract.controlIds.map((id, index) => {
      const control = headerControlsById.get(id)!;
      const left = 8 + index * 84;
      return {
        id,
        accessibleName: control.accessibleName,
        href: control.href,
        box: { left, right: left + 44, top: 10, bottom: 54, width: 44, height: 44 },
      };
    }),
  };
  assert.deepEqual(evaluateHeaderBreakpointContract(narrowHeaderContract, REVIEWED_HEADER_CONTROLS, validNarrowHeader), [], 'Exact narrow-header inventory and geometry must pass');
  const undersizedSearch = {
    ...validNarrowHeader,
    controls: validNarrowHeader.controls.map((control) => control.id === 'search'
      ? { ...control, box: { ...control.box, right: control.box.left + 18, width: 18 } }
      : control),
  };
  assert(
    evaluateHeaderBreakpointContract(narrowHeaderContract, REVIEWED_HEADER_CONTROLS, undersizedSearch)
      .some((issue) => issue.includes('below 44x44px')),
    'A clipped or undersized header action must fail even when it remains technically visible',
  );

  const safeScrollChild = rawOverflowCandidate({
    selector: '.safe-scroll > table',
    right: 180,
    width: 180,
    containedByScrollOwner: true,
    nearestScrollOwner: { selector: '.safe-scroll', left: 0, right: 100, clientWidth: 100, scrollWidth: 180, overflowX: 'auto' },
  });
  const safeClassification = classifyHorizontalOverflowCandidates(80, 100, [safeScrollChild]);
  assert(!safeClassification.elements.some(({ selector }) => selector === '.safe-scroll > table'), 'A child contained by an intentional scroller must not be named as a root culprit');

  const intrinsic = classifyHorizontalOverflowCandidates(20, 100, [rawOverflowCandidate({ right: 100, width: 100, clientWidth: 100, scrollWidth: 120 })]);
  assert(intrinsic.elements.some(({ reasons }) => reasons.includes('intrinsic-visible-overflow')), 'Intrinsic visible overflow must produce a culprit even when the border box fits');

  const fractional = classifyHorizontalOverflowCandidates(1.25, 100, [rawOverflowCandidate({ right: 101.25, width: 101.25 })]);
  assert.equal(fractional.elements[0]?.outsideRightPx, 1.25, 'Fractional overflow must be thresholded before display rounding');

  const many = classifyHorizontalOverflowCandidates(50, 100, Array.from({ length: 25 }, (_, index) => rawOverflowCandidate({
    selector: `.overflow-${index}`,
    right: 125 + index,
    width: 125 + index,
  })));
  assert.equal(many.candidateCount, 25);
  assert.equal(many.elements.length, 20);
  assert.equal(many.truncated, true);
}

runPageOracleMutationCanaries();

const homeSupportSource = readFileSync(path.join(repositoryRoot, 'tests/content-system.spec.ts'), 'utf8');
assert(homeSupportSource.includes('REVIEWED_HOME_SUPPORT_STATES'), 'HOME-002 must consume an independent reviewed state inventory');
assert(homeSupportSource.includes('REVIEWED_HOME_LIVE_MEETING_INDEX'), 'HOME-002 must use deterministic general-meeting fallback data');
assert(homeSupportSource.includes('evaluateHomeSupportStateContract'), 'HOME-002 must evaluate exact state semantics and destinations');
assert(!/HOME-002[\s\S]{0,5000}links\.length\)\.toBeGreaterThanOrEqual\(/.test(homeSupportSource), 'HOME-002 must not regress to a minimum arbitrary-link count');

const themeResponsiveSource = readFileSync(path.join(repositoryRoot, 'tests/theme-responsive.spec.ts'), 'utf8');
assert(themeResponsiveSource.includes('requestAnimationFrame'), 'THEME-003 must sample the pre-paint animation frame, not only hydrated DOM state');
assert(themeResponsiveSource.includes('evaluateDarkThemePaintContract'), 'THEME-003 must assert computed dark surface and foreground contrast');
assert(!/\[THEME-003\][\s\S]{0,5000}await audit\.goto\('\/'\);[\s\S]{0,500}document\.documentElement\.classList\.contains\('dark'\)/.test(themeResponsiveSource),
  'THEME-003 must not regress to sampling only the hydrated DOM after navigation');
assert(themeResponsiveSource.includes('REVIEWED_HEADER_BREAKPOINTS'), 'SHELL-002 must consume the exact reviewed breakpoint inventory');
assert(themeResponsiveSource.includes('evaluateHeaderBreakpointContract'), 'SHELL-002 must reject overlap, wrong controls, destinations, and undersized targets');

const shellContentSource = readFileSync(path.join(repositoryRoot, 'tests/shell-content.spec.ts'), 'utf8');
assert(shellContentSource.includes('REVIEWED_FOOTER_ACTIONS'), 'SHELL-004 must consume exact reviewed footer labels and destinations');
assert(!/\[SHELL-004\][\s\S]{0,3000}getByRole\('link', \{ name: new RegExp/.test(shellContentSource), 'SHELL-004 must not regress to label-only regex discovery');

const searchSource = readFileSync(path.join(repositoryRoot, 'tests/search.spec.ts'), 'utf8');
const searchFailureSource = searchSource.slice(searchSource.indexOf("[SEARCH-006]"));
assert(searchFailureSource.includes('[aria-busy="true"], .animate-spin'), 'SEARCH-006 must prove the failed-index spinner stopped');
assert(searchFailureSource.includes("body: '{not-valid-json'"), 'SEARCH-006 must inject a deterministic invalid index instead of relying on a network race');
assert(searchFailureSource.includes("name: 'complete site map', exact: true"), 'SEARCH-006 must assert the fallback link exact accessible name');
assert(searchFailureSource.includes("loggedGet(request, audit, '/sitemap')"), 'SEARCH-006 must independently probe the fallback destination');
assert(searchFailureSource.includes('await fallback.click()'), 'SEARCH-006 must activate the fallback and prove recovery navigation');

const entrySpecs = [...new Set(INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ entrySpecs }) => entrySpecs))].sort();
const declarations: DeclarationSummary[] = [];
const findings: SourceFinding[] = [];
for (const entrySpec of entrySpecs) {
  const result = analyzeAssertionSource(entrySpec, readFileSync(path.join(repositoryRoot, entrySpec), 'utf8'));
  declarations.push(...result.declarations);
  findings.push(...result.findings);
}

const isolationChecked = new Set<string>();
for (const auditCase of INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases)) {
  if (!auditCase.supportedModes.includes('single-site')
    || auditCase.auditId.startsWith('PAGE-')
    || auditCase.auditId === 'CONTENT-002') continue;
  const key = `${auditCase.entrySpec}\0${auditCase.auditId}`;
  if (isolationChecked.has(key)) continue;
  isolationChecked.add(key);
  const declaration = auditDeclarationSource(auditCase.entrySpec, auditCase.auditId);
  for (const detail of singleSiteIsolationProblems(declaration)) {
    findings.push({
      file: auditCase.entrySpec,
      line: 1,
      test: auditCase.auditId,
      detail: `Standalone-compatible declaration ${detail}.`,
    });
  }
}

const declarationCases = new Set(declarations.flatMap((declaration) => declaration.auditIds.map((auditId) => (
  `${auditId}\0${declaration.file}\0${declaration.applicability ?? ''}`
))));
const dynamicRouteDeclarations = declarations.filter(({ file, title }) => (
  file === 'tests/page-audit.spec.ts'
  && title.includes('${definition.id}')
));
const dynamicRouteDeclaration = dynamicRouteDeclarations[0];
const routeAuditIds = new Set(ROUTE_AUDIT_CATALOG.map(({ id }) => id));
const expectedRouteCases = pageAuditFamilyMembers()
  .map(({ definition, applicability }) => `${definition.id}\0${PAGE_AUDIT_ENTRY_SPEC}\0${applicability}`)
  .sort();
const registeredRouteCases = INSTALLED_PLUGIN_REGISTRY.plugins
  .flatMap(({ auditCases }) => auditCases)
  .filter(({ auditId }) => routeAuditIds.has(auditId))
  .map(({ auditId, entrySpec, applicability }) => `${auditId}\0${entrySpec}\0${applicability}`)
  .sort();
if (JSON.stringify(registeredRouteCases) !== JSON.stringify(expectedRouteCases)) {
  findings.push({
    file: 'audit/plugins.generated.json',
    line: 1,
    test: 'PAGE-*',
    detail: 'Generated PAGE cases must equal the reviewed route family exactly, with one route-specific applicability case per definition.',
  });
}
for (const plugin of INSTALLED_PLUGIN_REGISTRY.plugins) {
  for (const auditCase of plugin.auditCases) {
    const key = `${auditCase.auditId}\0${auditCase.entrySpec}\0${auditCase.applicability}`;
    const isExactGeneratedRouteCase = routeAuditIds.has(auditCase.auditId)
      && expectedRouteCases.includes(key)
      && auditCase.entrySpec === dynamicRouteDeclaration?.file;
    if (!declarationCases.has(key) && !isExactGeneratedRouteCase) {
      findings.push({ file: auditCase.entrySpec, line: 1, test: auditCase.auditId, detail: `Generated audit case ${auditCase.applicability} has no matching executable declaration.` });
    }
  }
}

if (dynamicRouteDeclarations.length !== 1 || !dynamicRouteDeclaration || dynamicRouteDeclaration.unconditionalOracleCount === 0) {
  findings.push({
    file: 'tests/page-audit.spec.ts',
    line: 1,
    test: 'PAGE-*',
    detail: 'Route-specific audit contracts require exactly one dynamic declaration wired to the family applicability oracle, with an unconditional product oracle.',
  });
}

const automatedAuditIds = new Set(ALL_AUDIT_CATALOG.filter(({ manual }) => !manual).map(({ id }) => id));
const executableAuditIds = new Set(
  INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases.map(({ auditId }) => auditId)),
);
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
