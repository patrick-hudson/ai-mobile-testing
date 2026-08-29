import { auditCaseTag, AUDIT_CASE_ID_ANNOTATION } from '../../shared/audit-case-identity.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function collectTests(suites, output = [], inheritedFiles = []) {
  if (!Array.isArray(suites)) fail('PLAYWRIGHT_ROWS_INVALID', 'Playwright results suites must be an array.');
  for (const suite of suites) {
    if (!isRecord(suite)) fail('PLAYWRIGHT_ROWS_INVALID', 'Playwright suite row is invalid.');
    const suiteFiles = typeof suite.file === 'string' ? [...inheritedFiles, suite.file] : inheritedFiles;
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) fail('PLAYWRIGHT_ROWS_INVALID', 'Playwright suite specs must be an array.');
      for (const spec of suite.specs) {
        if (!isRecord(spec) || !Array.isArray(spec.tests)) fail('PLAYWRIGHT_ROWS_INVALID', 'Playwright spec row is invalid.');
        const sourceFiles = typeof spec.file === 'string' ? [...suiteFiles, spec.file] : suiteFiles;
        for (const test of spec.tests) output.push({ test, spec, sourceFiles });
      }
    }
    if (suite.suites !== undefined) collectTests(suite.suites, output, suiteFiles);
  }
  return output;
}

export function validateSharedPlaywrightRows(document, descriptor) {
  if (!isRecord(document) || !Array.isArray(document.suites) || !Array.isArray(document.errors)) {
    fail('PLAYWRIGHT_ROWS_INVALID', 'Playwright JSON report has an invalid root schema.');
  }
  if (document.errors.length > 0) fail('PLAYWRIGHT_REPORT_ERROR', 'Playwright reported errors outside the compiler-issued work item.');
  const rows = collectTests(document.suites);
  if (rows.length === 0) fail('PLAYWRIGHT_ROW_MISSING', 'Playwright published no row for the compiler-issued work item.');
  const expectedTag = auditCaseTag(descriptor.caseId);
  const expectedJsonTag = expectedTag.startsWith('@') ? expectedTag.slice(1) : expectedTag;
  const normalized = rows.map(({ test, spec, sourceFiles }, index) => {
    if (!isRecord(test) || typeof test.projectName !== 'string' || !Array.isArray(test.results)
      || !Array.isArray(test.annotations)) {
      fail('PLAYWRIGHT_ROWS_INVALID', `Playwright row ${index} is malformed.`);
    }
    const annotations = test.annotations.filter((entry) => isRecord(entry) && entry.type === AUDIT_CASE_ID_ANNOTATION);
    const tags = [
      ...(Array.isArray(spec.tags) ? spec.tags : []),
      ...(Array.isArray(test.tags) ? test.tags : []),
    ];
    if (test.projectName !== descriptor.targetId || !sourceFiles.includes(descriptor.entrySpec)
      || annotations.length !== 1 || annotations[0].description !== descriptor.caseId
      || !tags.includes(expectedJsonTag)) {
      fail('PLAYWRIGHT_ROW_IDENTITY_MISMATCH', `Playwright row ${index} escaped its compiler-issued case, spec, or target.`);
    }
    if (test.results.length !== 1 || test.results[0]?.retry !== 0) {
      fail('PLAYWRIGHT_ROW_RETRY_INVALID', `Playwright row ${index} must contain exactly one zero-retry attempt.`);
    }
    const status = test.results[0].status;
    if (!['passed', 'failed', 'timedOut'].includes(status)) {
      fail('PLAYWRIGHT_ROW_INCOMPLETE', `Playwright row ${index} did not produce a terminal product outcome.`);
    }
    return {
      row: index + 1,
      title: String(spec.title ?? test.title ?? '').slice(0, 1_024),
      projectName: test.projectName,
      caseId: descriptor.caseId,
      entrySpec: descriptor.entrySpec,
      status,
      retry: 0,
    };
  });
  return Object.freeze({
    outcome: normalized.every(({ status }) => status === 'passed') ? 'completed_pass' : 'completed_product_failure',
    rows: Object.freeze(normalized.map(Object.freeze)),
  });
}
