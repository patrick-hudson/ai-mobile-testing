import { auditCaseTag, AUDIT_CASE_ID_ANNOTATION } from '../../shared/audit-case-identity.mjs';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { sealProductFailureSignature } from '../../shared/execution-contract.mjs';
import { parseVisualComparisonResult } from '../../shared/visual-baseline-contract.mjs';

const AUDIT_EVIDENCE_POLICY_ANNOTATION = 'audit-evidence-policy';
const EVIDENCE_MODES = new Set(['interaction-video', 'static-screenshot', 'structured-data']);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;
const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1_024;
const MAX_FAILURE_SEMANTIC_BYTES = 64 * 1_024;
const VISUAL_SPEC = 'tests/visual-regression.spec.ts';
const VISUAL_RESULT_ATTACHMENT = 'shared-visual-comparison-result';
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OBSERVATION_TIMESTAMP = /\b(observed|recorded|captured) at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/gi;
const CORRELATION_UUID = /\b(trace|request|run)[ -]?id([:= ]+)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableIdentityToken(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<dynamic>')
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/[^a-z0-9<>._:/#-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 240);
  return normalized || null;
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedFailureSemantics(value, descriptor) {
  if (typeof value !== 'string' || value.length < 1
    || Buffer.byteLength(value, 'utf8') > MAX_FAILURE_SEMANTIC_BYTES || value.includes('\0')) return null;
  let normalized = value.replace(ANSI_ESCAPE, '');
  for (const origin of [descriptor.origins?.candidate, descriptor.origins?.production]) {
    if (typeof origin === 'string' && origin.length > 0) {
      normalized = normalized.replace(new RegExp(`${escapedRegExp(origin)}(?=$|[/?#])`, 'g'), '<origin>');
    }
  }
  normalized = normalized
    .replace(OBSERVATION_TIMESTAMP, '$1 at <timestamp>')
    .replace(CORRELATION_UUID, '$1-id$2<uuid>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

function semanticDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hasAssertionSemantics(message, matcher) {
  const withoutCall = message
    .replace(/^error:\s*/i, '')
    .replace(new RegExp(`expect\\([^)]*\\)\\.${matcher}\\([^)]*\\)`, 'ig'), '')
    .replace(new RegExp(`\\b${matcher}\\b`, 'ig'), '')
    .replace(/\b(?:assertion|error|expect|expected|failed|received|actual)\b/gi, '')
    .replace(/[\s()[\]{}:;,."'`-]+/g, '');
  return withoutCall.length > 0;
}

function errorIdentity(error, descriptor) {
  if (!isRecord(error)) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  const matcher = message.match(/\b(to[A-Z][A-Za-z0-9]*)\b/)?.[1] ?? null;
  const location = isRecord(error.location) ? error.location : null;
  const stackLocation = typeof error.stack === 'string'
    ? error.stack.match(/(?:^|\n)\s*at .*?([^\s():]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)/)
    : null;
  const file = location?.file ?? stackLocation?.[1] ?? descriptor.entrySpec;
  const portableFile = String(file).replaceAll('\\', '/');
  const stableFile = portableFile.includes('/tests/')
    ? `tests/${portableFile.split('/tests/').at(-1)}`
    : descriptor.entrySpec;
  const line = Number.isSafeInteger(location?.line) ? location.line
    : (stackLocation ? Number(stackLocation[2]) : null);
  const matcherIdentity = stableIdentityToken(matcher);
  const semantics = normalizedFailureSemantics(message, descriptor);
  if (matcherIdentity === null || semantics === null || !hasAssertionSemantics(semantics, matcher)
    || !Number.isSafeInteger(line) || line < 1) return null;
  return `case:${descriptor.caseId}|location:${stableFile}:${line}|matcher:${matcherIdentity}|semantic:${semanticDigest(semantics)}`;
}

function findingIdentity(finding, descriptor) {
  if (!isRecord(finding)) return null;
  const stableId = ['id', 'ruleId', 'code', 'kind', 'category'].map((key) => stableIdentityToken(finding[key])).find(Boolean);
  const stableTitle = stableIdentityToken(finding.title);
  const severity = stableIdentityToken(finding.severity);
  const identity = stableId ?? stableTitle;
  const title = normalizedFailureSemantics(finding.title, descriptor);
  const detail = normalizedFailureSemantics(finding.detail, descriptor);
  if (identity === null || title === null || severity === null || detail === null
    || typeof finding.blocking !== 'boolean') return null;
  const semantics = JSON.stringify({
    title,
    severity,
    blocking: finding.blocking,
    detail,
  });
  return `case:${descriptor.caseId}|finding:${identity}|severity:${severity}|semantic:${semanticDigest(semantics)}`;
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

function evidencePolicy(annotations, index) {
  const matches = annotations.filter((entry) => isRecord(entry)
    && entry.type === AUDIT_EVIDENCE_POLICY_ANNOTATION && typeof entry.description === 'string');
  if (matches.length !== 1) fail('PLAYWRIGHT_EVIDENCE_POLICY_INVALID', `Playwright row ${index} lacks one exact evidence policy.`);
  let value;
  try { value = JSON.parse(matches[0].description); } catch {
    fail('PLAYWRIGHT_EVIDENCE_POLICY_INVALID', `Playwright row ${index} evidence policy is not valid JSON.`);
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || !EVIDENCE_MODES.has(value.mode)
    || typeof value.rationale !== 'string' || value.rationale.trim().length < 12 || value.rationale.length > 500) {
    fail('PLAYWRIGHT_EVIDENCE_POLICY_INVALID', `Playwright row ${index} evidence policy is invalid.`);
  }
  return { mode: value.mode, rationale: value.rationale.replace(/\s+/g, ' ').trim() };
}

function inlineBytes(value, index, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${index} attachment ${name} has invalid base64 content.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_INLINE_ATTACHMENT_BYTES) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${index} attachment ${name} exceeds its inline bound.`);
  }
  return bytes;
}

function normalizedAttachments(value, index) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 61) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${index} attachments are invalid or unbounded.`);
  }
  return value.map((attachment, attachmentIndex) => {
    if (!isRecord(attachment) || typeof attachment.name !== 'string' || !attachment.name.trim()
      || attachment.name.length > 240 || typeof attachment.contentType !== 'string'
      || !MEDIA_TYPE.test(attachment.contentType)
      || (typeof attachment.path === 'string') === (typeof attachment.body === 'string')) {
      fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${index} attachment ${attachmentIndex} is malformed.`);
    }
    if (typeof attachment.path === 'string') {
      if (!pathIsExactAbsolute(attachment.path)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${index} attachment ${attachment.name} path is unsafe.`);
      }
      return { name: attachment.name, contentType: attachment.contentType.toLowerCase(), path: attachment.path, body: null };
    }
    return {
      name: attachment.name,
      contentType: attachment.contentType.toLowerCase(),
      path: null,
      body: inlineBytes(attachment.body, index, attachment.name).toString('base64'),
    };
  });
}

function attachmentPurpose(attachment, row) {
  if (attachment.name === 'audit-result' || attachment.name === 'audit-result-summary'
    || attachment.contentType === 'application/json') return 'structured';
  if (row.status === 'passed' && row.evidencePolicy.mode === 'interaction-video'
    && attachment.contentType.startsWith('video/')) return 'primary';
  if (row.status === 'passed' && row.evidencePolicy.mode === 'static-screenshot'
    && attachment.contentType.startsWith('image/') && attachment.name !== 'screenshot'
    && !/^automatic(?:-|\s)/i.test(attachment.name)) return 'primary';
  return 'diagnostic';
}

function declaration(pathname, attachment, row, bytes) {
  return {
    path: pathname,
    mediaType: attachment.contentType,
    logicalName: attachment.name,
    purpose: attachmentPurpose(attachment, row),
    sizeBytes: bytes.length,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function attachmentPathMetadata(attachment, row) {
  return JSON.stringify({
    name: attachment.name,
    contentType: attachment.contentType,
    purpose: attachmentPurpose(attachment, row),
  });
}

async function writeImmutableAttachment(destination, bytes) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST' || !Buffer.from(await fs.readFile(destination)).equals(bytes)) throw error;
  }
}

async function boundedPublicationPath({ evidenceRoot, candidate, rowIndex, attachmentIndex, bytes }) {
  const extension = path.extname(candidate).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
  const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const relative = `playwright/published/row-${rowIndex + 1}/attachment-${attachmentIndex + 1}-${fingerprint}${safeExtension}`;
  await writeImmutableAttachment(path.join(evidenceRoot, ...relative.split('/')), bytes);
  return relative;
}

function pathIsExactAbsolute(value) {
  return value.startsWith('/') && !value.includes('\0') && !value.includes('\\')
    && !value.split('/').some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'));
}

function parseVisualRiskSource(value, descriptor) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [
    'caseId', 'items', 'kind', 'observedAt', 'schemaVersion', 'targetId',
  ].sort().join('\0') || value.schemaVersion !== 1 || value.kind !== 'shared-visual-comparison-result'
    || value.caseId !== descriptor.caseId || value.targetId !== descriptor.targetId
    || typeof value.observedAt !== 'string' || new Date(value.observedAt).toISOString() !== value.observedAt
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 256) {
    throw new TypeError('Shared visual comparison output has an invalid identity or shape.');
  }
  const ids = new Set();
  const items = value.items.map((item) => {
    if (!isRecord(item) || Object.keys(item).sort().join('\0') !== ['comparison', 'id'].join('\0')
      || typeof item.id !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(item.id)
      || ids.has(item.id)) throw new TypeError('Shared visual comparison item is invalid or duplicated.');
    ids.add(item.id);
    return Object.freeze({ id: item.id, comparison: parseVisualComparisonResult(item.comparison) });
  });
  if (items.some(({ comparison }) => ['absent', 'incompatible', 'unavailable'].includes(comparison.status))) {
    return Object.freeze({ status: 'UNAVAILABLE', observedAt: value.observedAt, changedItems: Object.freeze([]) });
  }
  return Object.freeze({
    status: 'COMPLETE',
    observedAt: value.observedAt,
    changedItems: Object.freeze(items.filter(({ comparison }) => comparison.status === 'CHANGED')),
  });
}

function summaryFrom(attachments, descriptor, index) {
  const summaries = attachments.filter(({ name, contentType, body }) => (
    name === 'audit-result-summary' && contentType === 'application/json' && body !== null
  ));
  const records = attachments.filter(({ name, contentType, path }) => (
    name === 'audit-result' && contentType === 'application/json' && path !== null
  ));
  if (summaries.length !== 1 || records.length !== 1) {
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `Playwright row ${index} requires one audit result and compact summary.`);
  }
  let summary;
  try { summary = JSON.parse(Buffer.from(summaries[0].body, 'base64').toString('utf8')); } catch {
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `Playwright row ${index} audit summary is invalid JSON.`);
  }
  const expectedBaseURL = descriptor.targetRole === 'production'
    ? descriptor.origins.production
    : descriptor.origins.candidate;
  const commonIdentity = isRecord(summary) && summary.schemaVersion === 1
    && summary.caseId === descriptor.caseId && summary.auditId === descriptor.definitionId
    && summary.project === descriptor.targetId && summary.baseURL === expectedBaseURL
    && Array.isArray(summary.findings) && Array.isArray(summary.steps);
  const modeIdentity = descriptor.mode === 'single-site'
    ? summary.mode === 'single-site' && summary.deploymentRole === descriptor.targetRole
    : summary.environment === descriptor.targetRole && Array.isArray(summary.coveredEnvironments)
      && summary.coveredEnvironments.includes(descriptor.targetRole);
  if (!commonIdentity || !modeIdentity) {
    fail('PLAYWRIGHT_ROW_IDENTITY_MISMATCH', `Playwright row ${index} audit summary identity disagrees with its compiler-issued work item.`);
  }
  return summary;
}

function enforcePrimaryEvidence(policy, attachments, summary, status, index) {
  const pathAttachments = attachments.filter(({ path }) => path !== null);
  if (status !== 'passed') {
    if (!pathAttachments.some(({ contentType }) => contentType.startsWith('image/')
      || contentType.startsWith('video/') || contentType === 'application/zip')) {
      fail('PLAYWRIGHT_REQUIRED_EVIDENCE_MISSING', `Playwright row ${index} product failure lacks diagnostic media or trace evidence.`);
    }
    return;
  }
  if (policy.mode === 'interaction-video') {
    if (!pathAttachments.some(({ contentType }) => contentType.startsWith('video/'))
      || !summary.steps.some((step) => isRecord(step) && step.kind === 'interaction')) {
      fail('PLAYWRIGHT_REQUIRED_EVIDENCE_MISSING', `Playwright row ${index} lacks its required interaction video and action/response step.`);
    }
  } else if (policy.mode === 'static-screenshot') {
    const purposeful = pathAttachments.some(({ name, contentType }) => contentType.startsWith('image/')
      && name !== 'screenshot' && !/^automatic(?:-|\s)/i.test(name));
    if (!purposeful) fail('PLAYWRIGHT_REQUIRED_EVIDENCE_MISSING', `Playwright row ${index} lacks its required static screenshot.`);
  }
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
  const assertionIdentities = [];
  let failureIdentityComplete = true;
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
    const policy = evidencePolicy(test.annotations, index);
    const attachments = normalizedAttachments(test.results[0].attachments, index);
    const summary = summaryFrom(attachments, descriptor, index);
    enforcePrimaryEvidence(policy, attachments, summary, status, index);
    if (status !== 'passed') {
      const errors = Array.isArray(test.results[0].errors) ? test.results[0].errors
        : (isRecord(test.results[0].error) ? [test.results[0].error] : []);
      if (errors.length === 0) failureIdentityComplete = false;
      for (const error of errors) {
        const identity = errorIdentity(error, descriptor);
        if (identity === null) failureIdentityComplete = false;
        else assertionIdentities.push(identity);
      }
    }
    return {
      row: index + 1,
      title: String(spec.title ?? test.title ?? '').slice(0, 1_024),
      projectName: test.projectName,
      caseId: descriptor.caseId,
      entrySpec: descriptor.entrySpec,
      status,
      retry: 0,
      evidencePolicy: policy,
      attachments,
    };
  });
  if (normalized.length !== 1) {
    fail('PLAYWRIGHT_ROW_COUNT_INVALID', 'A compiler-issued shared work item must produce exactly one canonical Playwright row.');
  }
  return Object.freeze({
    outcome: normalized.every(({ status }) => status === 'passed') ? 'completed_pass' : 'completed_product_failure',
    rows: Object.freeze(normalized.map(Object.freeze)),
    failureAssertionIdentities: Object.freeze([...new Set(assertionIdentities)].sort()),
    failureIdentityComplete,
  });
}

function exactRoot(value, label) {
  const resolved = path.resolve(value);
  if (typeof value !== 'string' || !path.isAbsolute(value) || resolved !== value || value.includes('\0')) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `${label} must be an exact absolute path.`);
  }
  return resolved;
}

function boundedAttachmentJson(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 8 * 1_048_576) {
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `${label} is not a bounded regular JSON file.`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code?.startsWith?.('PLAYWRIGHT_')) throw error;
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `${label} could not be read safely: ${error.message}`);
  }
}

export async function readContainedPlaywrightAttachment(candidate, realArtifactRoot, { afterOpen } = {}) {
  if (afterOpen !== undefined && typeof afterOpen !== 'function') {
    throw new TypeError('afterOpen must be a function when provided.');
  }
  let handle;
  try {
    handle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    await afterOpen?.();
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('PLAYWRIGHT_ATTACHMENT_INVALID', 'Playwright attachment is not a regular file.');
    }
    // The worker runs in Linux containers. Resolving the already-open file
    // descriptor binds containment to the opened inode instead of reopening a
    // pathname that may have been replaced after validation.
    const realCandidate = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (!realCandidate.startsWith(`${realArtifactRoot}${path.sep}`)) {
      fail('PLAYWRIGHT_ATTACHMENT_INVALID', 'Playwright attachment escaped its attempt artifact root.');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) {
      fail('PLAYWRIGHT_ATTACHMENT_INVALID', 'Playwright attachment changed while it was collected.');
    }
    return Object.freeze({ bytes, realCandidate });
  } catch (error) {
    if (error?.code?.startsWith?.('PLAYWRIGHT_')) throw error;
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright attachment could not be opened safely: ${error.message}`);
  } finally {
    await handle?.close();
  }
}

function validateAuditRecord(record, row, descriptor, index) {
  const expectedBaseURL = descriptor.targetRole === 'production'
    ? descriptor.origins.production
    : descriptor.origins.candidate;
  const identity = isRecord(record) && record.schemaVersion === 1
    && record.caseId === descriptor.caseId && record.auditId === descriptor.definitionId
    && record.project === descriptor.targetId && record.baseURL === expectedBaseURL
    && isRecord(record.evidencePolicy)
    && record.evidencePolicy.mode === row.evidencePolicy.mode
    && record.evidencePolicy.rationale === row.evidencePolicy.rationale
    && Array.isArray(record.findings) && Array.isArray(record.steps);
  const modeIdentity = descriptor.mode === 'single-site'
    ? record.mode === 'single-site' && record.deploymentRole === descriptor.targetRole
    : record.environment === descriptor.targetRole && Array.isArray(record.coveredEnvironments)
      && record.coveredEnvironments.includes(descriptor.targetRole);
  const summaryAttachment = row.attachments.find(({ name }) => name === 'audit-result-summary');
  let summary;
  try { summary = JSON.parse(Buffer.from(summaryAttachment.body, 'base64').toString('utf8')); } catch {
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `Playwright row ${index} summary could not be decoded.`);
  }
  if (!identity || !modeIdentity || JSON.stringify(summary.findings) !== JSON.stringify(record.findings)
    || JSON.stringify(summary.steps) !== JSON.stringify(record.steps)) {
    fail('PLAYWRIGHT_ROW_IDENTITY_MISMATCH', `Playwright row ${index} full audit evidence disagrees with its summary or descriptor.`);
  }
  return record;
}

export async function collectSharedPlaywrightArtifacts({ document, descriptor, artifactRoot, evidenceRoot } = {}) {
  const validated = validateSharedPlaywrightRows(document, descriptor);
  artifactRoot = exactRoot(artifactRoot, 'Playwright artifact root');
  evidenceRoot = exactRoot(evidenceRoot, 'Shared evidence root');
  const [realArtifactRoot, realEvidenceRoot] = await Promise.all([
    fs.realpath(artifactRoot),
    fs.realpath(evidenceRoot),
  ]);
  if (realArtifactRoot !== realEvidenceRoot && !realArtifactRoot.startsWith(`${realEvidenceRoot}${path.sep}`)) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', 'Playwright artifact root escaped the shared evidence root.');
  }
  const declarations = [];
  const paths = new Set();
  const canonicalPathAttachments = new Map();
  const sourcePathAttachments = new Map();
  const publicRows = [];
  const findingIdentities = [];
  let findingIdentityComplete = true;
  const visualInScope = descriptor.entrySpec === VISUAL_SPEC;
  let visualRiskSource = visualInScope
    ? Object.freeze({ status: 'UNAVAILABLE', observedAt: null, changedItems: Object.freeze([]) })
    : Object.freeze({ status: 'NOT_APPLICABLE', observedAt: null, changedItems: Object.freeze([]) });
  let visualResultCount = 0;
  for (let rowIndex = 0; rowIndex < validated.rows.length; rowIndex += 1) {
    const row = validated.rows[rowIndex];
    const publicAttachments = [];
    for (let attachmentIndex = 0; attachmentIndex < row.attachments.length; attachmentIndex += 1) {
      const attachment = row.attachments[attachmentIndex];
      if (attachment.body !== null) {
        const bytes = Buffer.from(attachment.body, 'base64');
        if (attachment.name === 'audit-result') {
          let record;
          try { record = JSON.parse(bytes.toString('utf8')); } catch {
            fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `Playwright row ${rowIndex} audit result is not valid JSON.`);
          }
          validateAuditRecord(record, row, descriptor, rowIndex);
          for (const finding of record.findings) {
            const identity = findingIdentity(finding, descriptor);
            if (identity === null) findingIdentityComplete = false;
            else findingIdentities.push(identity);
          }
        }
        if (attachment.name === VISUAL_RESULT_ATTACHMENT) {
          visualResultCount += 1;
          try { visualRiskSource = parseVisualRiskSource(JSON.parse(bytes.toString('utf8')), descriptor); } catch {
            visualRiskSource = Object.freeze({ status: 'UNAVAILABLE', observedAt: null, changedItems: Object.freeze([]) });
          }
        }
        const suffix = attachment.contentType === 'application/json' ? 'json' : 'bin';
        const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const relative = `playwright/inline/row-${rowIndex + 1}/attachment-${attachmentIndex + 1}-${fingerprint}.${suffix}`;
        const destination = path.join(evidenceRoot, ...relative.split('/'));
        await writeImmutableAttachment(destination, bytes);
        paths.add(relative);
        declarations.push(declaration(relative, attachment, row, bytes));
        publicAttachments.push({ name: attachment.name, contentType: attachment.contentType, path: relative });
        continue;
      }
      const candidate = path.resolve(attachment.path);
      if (candidate !== attachment.path || !candidate.startsWith(`${artifactRoot}${path.sep}`)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment escaped its attempt artifact root.`);
      }
      const sourceRelative = path.relative(evidenceRoot, candidate).split(path.sep).join('/');
      if (!sourceRelative || sourceRelative.startsWith('../')) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment path is unpublishable.`);
      }
      const { bytes, realCandidate } = await readContainedPlaywrightAttachment(candidate, realArtifactRoot);
      const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const metadata = attachmentPathMetadata(attachment, row);
      const previousAttachments = new Set([
        canonicalPathAttachments.get(realCandidate),
        sourcePathAttachments.get(sourceRelative),
      ].filter(Boolean));
      if (previousAttachments.size > 0) {
        if ([...previousAttachments].some((previous) => previous.metadata !== metadata
          || previous.contentDigest !== contentDigest || previous.sizeBytes !== bytes.length)) {
          fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment reuses a canonical file with conflicting metadata or content.`);
        }
        // Playwright can report the same path attachment more than once. One
        // exact logical declaration is sufficient; conflicting reuse remains
        // rejected so a path cannot smuggle two evidence identities.
        continue;
      }
      const relative = sourceRelative.length <= 240
        ? sourceRelative
        : await boundedPublicationPath({ evidenceRoot, candidate, rowIndex, attachmentIndex, bytes });
      if (paths.has(relative)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment publication path is duplicate.`);
      }
      paths.add(relative);
      const pathAttachment = {
        metadata,
        contentDigest,
        sizeBytes: bytes.length,
      };
      canonicalPathAttachments.set(realCandidate, pathAttachment);
      sourcePathAttachments.set(sourceRelative, pathAttachment);
      if (attachment.name === VISUAL_RESULT_ATTACHMENT) {
        visualResultCount += 1;
        try { visualRiskSource = parseVisualRiskSource(JSON.parse(bytes.toString('utf8')), descriptor); } catch {
          visualRiskSource = Object.freeze({ status: 'UNAVAILABLE', observedAt: null, changedItems: Object.freeze([]) });
        }
      }
      declarations.push(declaration(relative, attachment, row, bytes));
      publicAttachments.push({ name: attachment.name, contentType: attachment.contentType, path: relative });
      if (attachment.name === 'audit-result') {
        const record = validateAuditRecord(
          boundedAttachmentJson(bytes, `Playwright row ${rowIndex} audit result`), row, descriptor, rowIndex,
        );
        for (const finding of record.findings) {
          const identity = findingIdentity(finding, descriptor);
          if (identity === null) findingIdentityComplete = false;
          else findingIdentities.push(identity);
        }
      }
    }
    publicRows.push({ ...row, attachments: publicAttachments });
  }
  if (!visualInScope && visualResultCount > 0) {
    fail('PLAYWRIGHT_ROW_IDENTITY_MISMATCH', 'Non-visual work published a visual comparison result.');
  }
  if (visualInScope && visualResultCount !== 1) {
    visualRiskSource = Object.freeze({ status: 'UNAVAILABLE', observedAt: null, changedItems: Object.freeze([]) });
  }
  const assertionIdentities = [...new Set(validated.failureAssertionIdentities)].sort();
  const normalizedFindingIdentities = [...new Set(findingIdentities)].sort();
  const productFailureSignature = validated.outcome === 'completed_product_failure'
    && validated.failureIdentityComplete && findingIdentityComplete
    && assertionIdentities.length + normalizedFindingIdentities.length > 0
    ? sealProductFailureSignature({
      schemaVersion: 1,
      assertionIdentities,
      findingIdentities: normalizedFindingIdentities,
    })
    : null;
  return Object.freeze({
    outcome: validated.outcome,
    rows: Object.freeze(publicRows.map(Object.freeze)),
    artifacts: Object.freeze(declarations.map(Object.freeze)),
    visualRiskSource,
    productFailureSignature,
  });
}
