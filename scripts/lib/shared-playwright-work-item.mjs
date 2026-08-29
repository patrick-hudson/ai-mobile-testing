import { auditCaseTag, AUDIT_CASE_ID_ANNOTATION } from '../../shared/audit-case-identity.mjs';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const AUDIT_EVIDENCE_POLICY_ANNOTATION = 'audit-evidence-policy';
const EVIDENCE_MODES = new Set(['interaction-video', 'static-screenshot', 'structured-data']);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;
const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1_024;

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
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
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

function pathIsExactAbsolute(value) {
  return value.startsWith('/') && !value.includes('\0') && !value.includes('\\')
    && !value.split('/').some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'));
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
  });
}

function exactRoot(value, label) {
  const resolved = path.resolve(value);
  if (typeof value !== 'string' || !path.isAbsolute(value) || resolved !== value || value.includes('\0')) {
    fail('PLAYWRIGHT_ATTACHMENT_INVALID', `${label} must be an exact absolute path.`);
  }
  return resolved;
}

async function boundedAttachmentJson(file, label) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 8 * 1_048_576) {
      fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `${label} is not a bounded regular JSON file.`);
    }
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error?.code?.startsWith?.('PLAYWRIGHT_')) throw error;
    fail('PLAYWRIGHT_STRUCTURED_EVIDENCE_INVALID', `${label} could not be read safely: ${error.message}`);
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
  const publicRows = [];
  for (let rowIndex = 0; rowIndex < validated.rows.length; rowIndex += 1) {
    const row = validated.rows[rowIndex];
    const publicAttachments = [];
    for (let attachmentIndex = 0; attachmentIndex < row.attachments.length; attachmentIndex += 1) {
      const attachment = row.attachments[attachmentIndex];
      if (attachment.body !== null) {
        const bytes = Buffer.from(attachment.body, 'base64');
        const suffix = attachment.contentType === 'application/json' ? 'json' : 'bin';
        const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const relative = `playwright/inline/row-${rowIndex + 1}/attachment-${attachmentIndex + 1}-${fingerprint}.${suffix}`;
        const destination = path.join(evidenceRoot, ...relative.split('/'));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        paths.add(relative);
        declarations.push({ path: relative, mediaType: attachment.contentType });
        publicAttachments.push({ name: attachment.name, contentType: attachment.contentType, path: relative });
        continue;
      }
      const candidate = path.resolve(attachment.path);
      if (candidate !== attachment.path || !candidate.startsWith(`${artifactRoot}${path.sep}`)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment escaped its attempt artifact root.`);
      }
      const [stat, realCandidate] = await Promise.all([fs.lstat(candidate), fs.realpath(candidate)]);
      if (!stat.isFile() || stat.isSymbolicLink() || !realCandidate.startsWith(`${realArtifactRoot}${path.sep}`)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment is not a contained regular file.`);
      }
      const relative = path.relative(evidenceRoot, candidate).split(path.sep).join('/');
      if (!relative || relative.startsWith('../') || relative.length > 240 || paths.has(relative)) {
        fail('PLAYWRIGHT_ATTACHMENT_INVALID', `Playwright row ${rowIndex} attachment path is duplicate or unpublishable.`);
      }
      paths.add(relative);
      declarations.push({ path: relative, mediaType: attachment.contentType });
      publicAttachments.push({ name: attachment.name, contentType: attachment.contentType, path: relative });
      if (attachment.name === 'audit-result') {
        validateAuditRecord(await boundedAttachmentJson(candidate, `Playwright row ${rowIndex} audit result`), row, descriptor, rowIndex);
      }
    }
    publicRows.push({ ...row, attachments: publicAttachments });
  }
  return Object.freeze({
    outcome: validated.outcome,
    rows: Object.freeze(publicRows.map(Object.freeze)),
    artifacts: Object.freeze(declarations.map(Object.freeze)),
  });
}
