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

function auditDeclarationSource(file: string, auditId: string): string {
  const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
  const start = source.indexOf(`[${auditId}]`);
  assert.notEqual(start, -1, `${file} must retain the ${auditId} executable declaration`);
  const followingDeclarations = [
    source.indexOf('\ninteractionTest(', start + auditId.length + 2),
    source.indexOf('\nstaticTest(', start + auditId.length + 2),
    source.indexOf('\nstructuredTest(', start + auditId.length + 2),
  ].filter((index) => index >= 0);
  const end = followingDeclarations.length > 0 ? Math.min(...followingDeclarations) : source.length;
  return source.slice(start, end);
}

function runEvidenceBackedOracleCanaries(): void {
  const search = auditDeclarationSource('tests/search.spec.ts', 'SEARCH-002');
  assert.match(search, /getByRole\('option',\s*\{ name: \/helper medications\.\*clonidine\/i \}\)/, 'SEARCH-002 must use the rendered listbox option role');
  assert.match(search, /toHaveAttribute\('href', `\$\{helperPath\}#clonidine`\)/, 'SEARCH-002 must assert the reviewed destination exactly');

  const notFound = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-007');
  const clearIndex = notFound.indexOf('await search.clear()');
  const recoveryClickIndex = notFound.indexOf('await recoveryLink.click()');
  assert(clearIndex >= 0 && recoveryClickIndex > clearIndex, 'ENV-007 must clear the results layer and reacquire the recovery link before clicking it');

  const calculator = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-006');
  assert.match(calculator, /dataset\.auditPrintRequested/, 'CALC-006 must wait for the print document’s own load-to-print signal');
  assert.match(calculator, /name: 'Taper Schedule', exact: true/, 'CALC-006 must assert the actual print H1');
  assert.match(calculator, /7-OH · 15 mg × 4\/day → jump-off at 5 mg over 30 days/, 'CALC-006 must assert the exact reviewed default print subtitle');

  const meetingIntent = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-003');
  assert.match(meetingIntent, /url\.href === expectedDestination/, 'MEET-003 must intercept only the exact rendered external destination');
  assert.match(meetingIntent, /route\.fulfill\(/, 'MEET-003 must terminate the third-party request deterministically');
  assert.match(meetingIntent, /capturedDestination[\s\S]*toBe\(expectedDestination\)/, 'MEET-003 must compare the requested destination exactly');
  assert.doesNotMatch(meetingIntent, /popup\.waitForURL/, 'MEET-003 must not wait for third-party navigation completion');

  const meetingFilters = auditDeclarationSource('tests/meetings.spec.ts', 'MEET-004');
  assert.match(meetingFilters, /setTimeout\(MEET_FILTER_TOTAL_TIMEOUT_MS\)/, 'MEET-004 must retain its explicit end-to-end budget');
  assert.match(meetingFilters, /preparationDurationMs[\s\S]*toBeLessThan\(MEET_FILTER_PREPARATION_BUDGET_MS\)/, 'MEET-004 must preserve a bounded preparation partition');

  const calculatorDefaults = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-001');
  assert.match(calculatorDefaults, /substanceDefaults[\s\S]*MGM-15[\s\S]*Pseudo/, 'CALC-001 must retain an explicit vector for every offered substance');
  assert.match(calculatorDefaults, /toHaveCount\(expected\.rows\)/, 'CALC-001 must prove that each selected substance regenerates its expected schedule');

  const calculatorBoundaries = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-002');
  assert.match(calculatorBoundaries, /not-a-number[\s\S]*toHaveCount\(0\)/, 'CALC-002 must reject malformed input without leaving a stale plan');
  assert.match(calculatorBoundaries, /Times per day', '12'[\s\S]*checkValidity\(\)/, 'CALC-002 must prove the maximum valid frequency');
  assert.match(calculatorBoundaries, /validity\.rangeOverflow[\s\S]*toHaveCount\(0\)/, 'CALC-002 must fail closed beyond the maximum frequency');

  const calculatorSchedule = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-003');
  assert.match(calculatorSchedule, /const golden: TaperScheduleRow\[][\s\S]*day: 10[\s\S]*readTaperSchedule\(page\)\)\.toEqual\(golden\)/, 'CALC-003 must compare every ten-day row with an independent golden vector');
  assert.match(calculatorSchedule, /233 mg/, 'CALC-003 must preserve the independent exact supply oracle');

  const simpleSr17 = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-007');
  assert.match(simpleSr17, /goldenProtocols: Record<7 \| 10 \| 14/, 'CALC-007 must retain exact vectors for all three documented protocol lengths');
  assert.match(simpleSr17, /readSimpleSchedule\(page\)\)\.toEqual\(goldenProtocols\[days\]\.rows\)/, 'CALC-007 must compare every rendered SR-17 row with the golden protocol');
  assert.match(simpleSr17, /1518\.75 mg[\s\S]*tablets: '31'/, 'CALC-007 must preserve exact total and tablet-supply boundaries');

  const arithmetic = auditDeclarationSource('tests/calculators.spec.ts', 'CALC-009');
  assert.match(arithmetic, /published buprenorphine table[\s\S]*two-day 7-OH[\s\S]*explicit zero jump-off/, 'CALC-009 must retain representative, minimum-duration, and explicit-zero black-box cases');
  assert.match(arithmetic, /expect\(rows\)\.toEqual\(golden\)/, 'CALC-009 must compare deployed output to independent constants');
  assert.match(arithmetic, /schedule-stop-row[\s\S]*Stop\. Taper complete/, 'CALC-009 must prove the explicit-zero stop response');

  const routeInventory = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-002');
  assert.match(routeInventory, /mapWithConcurrency\(CANDIDATE_HTML_ROUTES/, 'ENV-002 must issue a bounded probe for every declared candidate route');
  assert.match(routeInventory, /response\.status\(\)[\s\S]*toBe\(200\)/, 'ENV-002 must require successful HTML responses');
  assert.match(routeInventory, /canonical\.origin[\s\S]*ENVIRONMENTS\.production\.baseURL[\s\S]*canonical\.pathname[\s\S]*route\.path/, 'ENV-002 must prove the exact public canonical origin and route');

  const internalLinks = auditDeclarationSource('tests/content-system.spec.ts', 'CONTENT-003');
  assert.match(internalLinks, /extractHtmlTagAttributes\(html, 'a', 'href'\)/, 'CONTENT-003 must crawl rendered anchor hrefs instead of replaying only the registry');
  assert.match(internalLinks, /internalReferences\.length[\s\S]*CANDIDATE_HTML_ROUTES\.length \* 3/, 'CONTENT-003 must fail if anchor extraction silently collapses');
  assert.match(internalLinks, /missingFragments[\s\S]*toEqual\(\[\]\)/, 'CONTENT-003 must require every rendered fragment target to exist');

  const contentRendering = readFileSync(path.join(repositoryRoot, 'tests/visual-regression.spec.ts'), 'utf8');
  const contentRenderingDeclaration = auditDeclarationSource('tests/visual-regression.spec.ts', 'CONTENT-002');
  for (const primitive of ['prose paragraphs', 'ordered or unordered list items', 'medical callout blockquote', 'schedule table', 'inline or block code', 'native disclosure']) {
    assert.match(contentRendering, new RegExp(primitive), `CONTENT-002 must retain the ${primitive} contract`);
  }
  assert.match(contentRendering, /\.open = true/, 'CONTENT-002 must inspect disclosure content in its expanded state');
  assert.match(contentRendering, /scrollWidth[\s\S]*clientWidth[\s\S]*scrollHeight[\s\S]*clientHeight/, 'CONTENT-002 must measure both horizontal and vertical content clipping');
  assert.match(contentRendering, /lineClamp[\s\S]*textOverflow/, 'CONTENT-002 must reject truncating line clamps and ellipses on reviewed content');
  assert.match(contentRendering, /result\.issues[\s\S]*toEqual\(\[\]\)/, 'CONTENT-002 must fail when any primitive has a clipping issue');
  assert.match(contentRenderingDeclaration, /Inspect critical content primitives[\s\S]*assertRepresentativeContentPrimitives/, 'CONTENT-002 must execute the primitive clipping contract from the browser audit');

  const assets = auditDeclarationSource('tests/contracts.spec.ts', 'ENV-008');
  assert.match(assets, /extractFirstPartyAssetReferences[\s\S]*htmlAssets\.length/, 'ENV-008 must discover assets from every candidate route document');
  assert.match(assets, /extractCssReferences[\s\S]*nestedCssAssets/, 'ENV-008 must traverse first-party assets referenced by CSS');
  assert.match(assets, /expectedContentType[\s\S]*toMatch\(expectedContentType\)/, 'ENV-008 must enforce extension-appropriate response types');

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
  assert.match(keyboard, /toHaveLength\(12\)/, 'A11Y-002 must retain two evidence checkpoints for every critical keyboard task');

  const drawer = auditDeclarationSource('tests/navigation.spec.ts', 'NAV-001');
  assert.match(drawer, /focusableCount[\s\S]*Shift\+Tab[\s\S]*data-audit-focus-origin/, 'NAV-001 must prove forward and reverse modal focus wrapping');
  for (const closeMethod of ['Close with Escape', 'Close with the named close control', 'Close with the backdrop']) {
    assert.match(drawer, new RegExp(closeMethod), `NAV-001 must retain: ${closeMethod}`);
  }
}

runEvidenceBackedOracleCanaries();

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
