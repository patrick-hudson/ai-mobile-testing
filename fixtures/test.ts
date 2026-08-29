import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test as base, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { ALL_AUDIT_BY_ID } from '../audit/definitions.js';
import { parseAuditProjectMetadata, resolveProjectPath } from '../audit/environments.js';
import {
  AUDIT_CASE_ID_ANNOTATION,
  auditCaseTag,
  resolveDeclaredAuditCaseId,
  type ExecutableAuditCaseRegistry,
} from '../audit/execution-selection.js';
import { firstBracketedAuditId } from '../audit/audit-id.js';
import { interactionVideoDelayMs, type InteractionVideoPhase } from '../audit/interaction-pacing.js';
import { classifyHorizontalOverflowCandidates } from '../audit/overflow-evidence.js';
import {
  AUDIT_APPLICABILITY_ANNOTATION,
  AUDIT_EVIDENCE_POLICY_ANNOTATION,
  assertStaticCheckpoint,
  createEvidencePolicy,
  parseAuditApplicabilityAnnotation,
  parseEvidencePolicyAnnotation,
  serializeEvidencePolicy,
} from '../audit/evidence-policy.js';
import { assertAuditDefinition, auditDefinitionsEqual } from '../audit/plugins.js';
import { LOCAL_AUDIT_TARGETS, SINGLE_SITE_LOCAL_AUDIT_TARGETS } from '../audit/targets.js';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  boundedGalleryText,
  normalizeGalleryRoute,
  type GalleryCaptureMetadata,
  type GalleryMemberRole,
} from '../shared/gallery-contract.mjs';
import {
  VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import {
  singleSiteTargetMatchesAuditApplicability,
  targetMatchesAuditApplicability,
} from '../shared/target-applicability.mjs';
import { runnerRevisionDigest } from '../shared/runner-revision.mjs';
import type {
  AuditDefinition,
  AuditApplicability,
  AuditEvidenceRecord,
  AuditEvidenceMode,
  AuditEvidencePolicy,
  AuditFinding,
  AuditObservation,
  AuditRuntimeExpectation,
  AuditThirdPartyTelemetryDiagnostic,
  AuditStepRecord,
  AuditEnvironment,
  AuditProjectMetadata,
  PageInspection,
} from '../audit/types.js';

const executableCaseRegistry = JSON.parse(
  readFileSync(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'),
) as ExecutableAuditCaseRegistry;
const MAX_STRUCTURED_EVIDENCE_BYTES = 32 * 1_048_576;
const MAX_AUDIT_RESULT_SUMMARY_BYTES = 64 * 1_024;

function activeRunMode(): 'comparative' | 'single-site' {
  const value = process.env.AUDIT_RUN_MODE;
  if (value === undefined || value === '' || value === 'comparative') return 'comparative';
  if (value === 'single-site') return 'single-site';
  throw new Error('AUDIT_RUN_MODE must be exactly comparative or single-site.');
}

function timestamp(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|password|signature/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function expectedResponseConsoleDerivative(
  event: { text: string; locationUrl: string | null },
  expectations: readonly AuditRuntimeExpectation[],
): AuditRuntimeExpectation | null {
  if (!event.locationUrl) return null;
  const expectation = expectations.find(({ kind, target, expected, matched }) => (
    kind === 'response-status'
    && matched
    && target === event.locationUrl
    && typeof expected === 'number'
    && expected >= 400
  ));
  if (!expectation || typeof expectation.expected !== 'number') return null;
  const status = String(expectation.expected);
  const chromiumOrWebKit = new RegExp(
    `^Failed to load resource: the server responded with a status of ${status}(?:\\s*\\([^\\r\\n]*\\))?$`,
    'i',
  );
  const firefox = new RegExp(`^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\\s+\\S+\\s+\\[HTTP\\/[^\\]]*\\s${status}(?:\\s|\\])`, 'i');
  return chromiumOrWebKit.test(event.text.trim()) || firefox.test(event.text.trim()) ? expectation : null;
}

const CLOUDFLARE_RUM_ENDPOINT = 'https://cloudflareinsights.com/cdn-cgi/rum';
const GOOGLE_TAG_ID = 'G-1ZPHE0EXTM';

function urlMatches(value: string | null, expectedOrigin: string, expectedPath: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === expectedOrigin && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

function cloudflareRumResponse(
  responses: readonly AuditEvidenceRecord['httpResponses'][number][],
): AuditEvidenceRecord['httpResponses'][number] | null {
  return responses.find(({ firstParty, status, url }) => (
    !firstParty
    && status >= 400
    && urlMatches(url, 'https://cloudflareinsights.com', '/cdn-cgi/rum')
  )) ?? null;
}

function googleTagResponse(
  responses: readonly AuditEvidenceRecord['httpResponses'][number][],
): AuditEvidenceRecord['httpResponses'][number] | null {
  return responses.find(({ firstParty, url }) => {
    if (firstParty) return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === 'https://www.googletagmanager.com'
        && parsed.pathname === '/gtag/js'
        && parsed.searchParams.get('id') === GOOGLE_TAG_ID;
    } catch {
      return false;
    }
  }) ?? null;
}

export function expectedThirdPartyTelemetryResponseDiagnostic(
  response: AuditEvidenceRecord['httpResponses'][number],
): AuditThirdPartyTelemetryDiagnostic | null {
  if (
    response.firstParty
    || response.status < 400
    || !urlMatches(response.url, 'https://cloudflareinsights.com', '/cdn-cgi/rum')
  ) return null;
  return {
    provider: 'cloudflare-rum',
    surface: 'http-response',
    message: `${response.method} ${response.status} ${CLOUDFLARE_RUM_ENDPOINT}`,
    sourceUrl: response.url,
    status: response.status,
  };
}

export function classifyExpectedThirdPartyTelemetryDiagnostic(
  event: { text: string; sourceUrl: string | null; surface: 'console-error' | 'page-error' },
  responses: readonly AuditEvidenceRecord['httpResponses'][number][],
  context: { cloudflareRumCausallyObserved?: boolean } = {},
): AuditThirdPartyTelemetryDiagnostic | null {
  const text = event.text.trim();
  const rumResponse = cloudflareRumResponse(responses);
  const sourceIsRum = urlMatches(event.sourceUrl, 'https://cloudflareinsights.com', '/cdn-cgi/rum');
  const exactCloudflareNativeDiagnostic = (
    /^Access to (?:XMLHttpRequest|resource) at 'https:\/\/cloudflareinsights\.com\/cdn-cgi\/rum' from origin 'https?:\/\/[^']+' has been blocked by CORS policy:/i.test(text)
    || /^(?:\[JavaScript Error: ")?Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https:\/\/cloudflareinsights\.com\/cdn-cgi\/rum\./i.test(text)
    || /^\/cloudflareinsights\.com\/cdn-cgi\/rum due to access control checks\.$/i.test(text)
    || /^Beacon API cannot load https:\/\/cloudflareinsights\.com\/cdn-cgi\/rum\. Origin https?:\/\/[^ ]+ is not allowed by Access-Control-Allow-Origin\. Status code: 404$/i.test(text)
  );
  const exactSourceBoundDiagnostic = sourceIsRum && (
    /^Failed to load resource:\s*net::ERR_FAILED$/i.test(text)
    || /^(?:Failed to load resource:\s*)?Origin https?:\/\/[^ ]+ is not allowed by Access-Control-Allow-Origin\. Status code: 404$/i.test(text)
  );
  const exactCausallyPairedWebKitDiagnostic = context.cloudflareRumCausallyObserved === true
    && /^(?:Failed to load resource:\s*)?Origin https?:\/\/[^ ]+ is not allowed by Access-Control-Allow-Origin\. Status code: 404$/i.test(text);
  if (exactCloudflareNativeDiagnostic || exactSourceBoundDiagnostic || exactCausallyPairedWebKitDiagnostic) {
    return {
      provider: 'cloudflare-rum',
      surface: event.surface,
      message: text,
      sourceUrl: event.sourceUrl,
      status: rumResponse?.status ?? null,
    };
  }

  const gtagResponse = googleTagResponse(responses);
  if (gtagResponse) {
    const unwrapped = text
      .replace(/^\[JavaScript Error:\s*"/, '')
      .replace(/"\s+\{file:\s+"https?:\/\/[^"\r\n]+"\s+line:\s+\d+\}\]$/, '');
    if (/^Cookie [“"]_ga(?:_[A-Z0-9]+)?[”"] has been rejected for invalid domain\.$/i.test(unwrapped)) {
      return {
        provider: 'google-analytics',
        surface: event.surface,
        message: text,
        sourceUrl: event.sourceUrl,
        status: gtagResponse.status,
      };
    }
  }

  return null;
}

function verboseLog(event: string, detail: Record<string, unknown>): void {
  if (process.env.AUDIT_VERBOSE !== '1') return;
  process.stdout.write(`${new Date().toISOString()} [AUDIT_${event}] ${JSON.stringify(detail)}\n`);
}

export class AuditRun {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly evidencePolicy: AuditEvidencePolicy;
  readonly caseId: string | null;
  private currentDefinition: AuditDefinition | null;
  private checkpointCount = 0;
  private interactionActionStepCount = 0;
  private readonly coveredEnvironmentSet = new Set<AuditEnvironment>();
  private readonly pendingFirstPartyRequests = new Set<Request>();
  private readonly runtimeExpectations: AuditRuntimeExpectation[] = [];
  private lastRuntimeActivityAt = Date.now();
  private readonly galleryAttachmentOccurrences = new Map<string, number>();
  private readonly structuredAttachmentOccurrences = new Map<string, number>();
  private readonly loggedTelemetryDiagnostics = new Set<string>();
  readonly startedAt = timestamp();
  readonly steps: AuditStepRecord[] = [];
  readonly observations: AuditObservation[] = [];
  readonly findings: AuditFinding[] = [];
  readonly pageInspections: PageInspection[] = [];
  readonly consoleErrors: string[] = [];
  readonly consoleWarnings: string[] = [];
  readonly pageErrors: string[] = [];
  readonly httpResponses: AuditEvidenceRecord['httpResponses'] = [];
  readonly failedRequests: Array<{ url: string; reason: string }> = [];
  readonly badResponses: Array<{ url: string; status: number }> = [];
  readonly thirdPartyTelemetryDiagnostics: AuditThirdPartyTelemetryDiagnostic[] = [];
  private readonly consoleErrorEvents: Array<{
    rendered: string;
    text: string;
    locationUrl: string | null;
    sourceUrl: string | null;
  }> = [];
  private readonly pageErrorEvents: Array<{ text: string; sourceUrl: null }> = [];

  constructor(page: Page, testInfo: TestInfo, evidencePolicy: AuditEvidencePolicy) {
    this.page = page;
    this.testInfo = testInfo;
    this.evidencePolicy = evidencePolicy;
    const auditId = firstBracketedAuditId(testInfo.title);
    this.currentDefinition = auditId ? (ALL_AUDIT_BY_ID.get(auditId) ?? null) : null;
    const project = parseAuditProjectMetadata(testInfo.project.metadata);
    const declaredCaseIds = testInfo.annotations
      .filter(({ type }) => type === AUDIT_CASE_ID_ANNOTATION)
      .map(({ description }) => description?.trim() ?? '')
      .filter(Boolean);
    if (project.mode === 'single-site' && declaredCaseIds.length !== 1) {
      throw new Error(`Single-site execution must bind exactly one compiled case ID; received ${declaredCaseIds.length}.`);
    }
    this.caseId = declaredCaseIds[0] ?? null;
    if (project.mode === 'comparative') this.coveredEnvironmentSet.add(project.environment);
    verboseLog('TEST_START', {
      auditId: auditId ?? 'UNMAPPED',
      caseId: this.caseId,
      project: testInfo.project.name,
      title: testInfo.title,
      evidencePolicy,
    });

    page.on('console', (message) => {
      const rendered = `${message.type()}: ${message.text()}`;
      if (message.type() === 'error' && !this.matchRuntimeExpectation('console-error', 'console', message.text())) {
        this.consoleErrors.push(rendered);
        const rawLocationUrl = message.location().url;
        this.consoleErrorEvents.push({
          rendered,
          text: message.text(),
          locationUrl: rawLocationUrl && this.isFirstParty(rawLocationUrl) ? redactUrl(rawLocationUrl) : null,
          sourceUrl: rawLocationUrl ? redactUrl(rawLocationUrl) : null,
        });
      }
      if (message.type() === 'warning') this.consoleWarnings.push(rendered);
      if (message.type() === 'error' || message.type() === 'warning') this.markRuntimeActivity();
    });
    page.on('pageerror', (error) => {
      if (!this.matchRuntimeExpectation('page-error', 'page', error.message)) {
        this.pageErrors.push(error.message);
        this.pageErrorEvents.push({ text: error.message, sourceUrl: null });
      }
      this.markRuntimeActivity();
    });
    page.on('request', (request) => {
      if (!this.isFirstParty(request.url())) return;
      this.pendingFirstPartyRequests.add(request);
      this.markRuntimeActivity();
    });
    page.on('requestfinished', (request) => {
      if (this.pendingFirstPartyRequests.delete(request)) this.markRuntimeActivity();
    });
    page.on('requestfailed', (request) => {
      if (!this.isFirstParty(request.url())) return;
      this.pendingFirstPartyRequests.delete(request);
      const failure = {
        url: redactUrl(request.url()),
        reason: request.failure()?.errorText ?? 'unknown request failure',
      };
      if (!this.matchRuntimeExpectation('request-failure', redactUrl(request.url()), failure.reason)) {
        this.failedRequests.push(failure);
      }
      this.markRuntimeActivity();
      verboseLog('HTTP_FAILURE', { method: request.method(), resourceType: request.resourceType(), ...failure });
    });
    page.on('response', (response) => {
      const request = response.request();
      const firstParty = this.isFirstParty(response.url());
      const record = {
        url: redactUrl(response.url()),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        contentType: response.headers()['content-type'] ?? null,
        fromServiceWorker: response.fromServiceWorker(),
        firstParty,
      };
      this.httpResponses.push(record);
      this.markRuntimeActivity();
      verboseLog('HTTP', record);
      const expected = firstParty
        && this.matchRuntimeExpectation('response-status', redactUrl(response.url()), response.status());
      if (firstParty && response.status() >= 400 && !expected) {
        this.badResponses.push({ url: record.url, status: response.status() });
      }
    });
  }

  get definition(): AuditDefinition | null {
    return this.currentDefinition;
  }

  setDefinition(definition: AuditDefinition): void {
    const validated = assertAuditDefinition(definition, 'audit.setDefinition definition');
    const titleAuditId = firstBracketedAuditId(this.testInfo.title);
    if (titleAuditId && titleAuditId !== validated.id) {
      throw new Error(`audit.setDefinition ID ${validated.id} does not match title audit ID ${titleAuditId}.`);
    }
    const registered = ALL_AUDIT_BY_ID.get(validated.id);
    if (registered && !auditDefinitionsEqual(registered, validated)) {
      throw new Error(`audit.setDefinition cannot replace registered metadata for ${validated.id}.`);
    }
    this.currentDefinition = registered ?? validated;
  }

  private isFirstParty(value: string): boolean {
    try {
      const configured = new URL(this.environmentBaseURL());
      const target = new URL(value);
      return target.origin === configured.origin;
    } catch {
      return false;
    }
  }

  private markRuntimeActivity(): void {
    this.lastRuntimeActivityAt = Date.now();
  }

  private expectationUrl(urlOrPath: string): string {
    let url: URL;
    try {
      url = new URL(urlOrPath, this.environmentBaseURL());
    } catch {
      throw new Error(`Runtime expectation URL is invalid: ${urlOrPath}`);
    }
    if (!this.isFirstParty(url.href)) {
      throw new Error(`Runtime expectations are limited to the active first-party origin: ${url.href}`);
    }
    return redactUrl(url.href);
  }

  private matchRuntimeExpectation(
    kind: AuditRuntimeExpectation['kind'],
    target: string,
    observed: string | number,
  ): boolean {
    const expectation = this.runtimeExpectations.find((candidate) => (
      !candidate.matched
      && candidate.kind === kind
      && candidate.target === target
      && (candidate.expected === '*' || candidate.expected === observed)
    ));
    if (!expectation) return false;
    expectation.matched = true;
    verboseLog('EXPECTED_RUNTIME_EVENT', { kind, target: redactUrl(target), observed });
    return true;
  }

  private addRuntimeExpectation(expectation: Omit<AuditRuntimeExpectation, 'matched'>): void {
    if (this.runtimeExpectations.some(({ kind, target }) => kind === expectation.kind && target === expectation.target)) {
      throw new Error(`Duplicate ${expectation.kind} expectation for ${expectation.target}.`);
    }
    this.runtimeExpectations.push({ ...expectation, matched: false });
  }

  expectResponseStatus(urlOrPath: string, status: number): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`Expected response status must be an HTTP status integer, received ${status}.`);
    }
    const target = this.expectationUrl(urlOrPath);
    if (this.httpResponses.some((response) => response.url === redactUrl(target))) {
      throw new Error(`Expected response status for ${target} must be declared before the request starts.`);
    }
    this.addRuntimeExpectation({ kind: 'response-status', target, expected: status });
  }

  expectRequestFailure(urlOrPath: string, exactReason?: string): void {
    const target = this.expectationUrl(urlOrPath);
    if (this.failedRequests.some((failure) => failure.url === redactUrl(target))) {
      throw new Error(`Expected request failure for ${target} must be declared before the request starts.`);
    }
    this.addRuntimeExpectation({ kind: 'request-failure', target, expected: exactReason ?? '*' });
  }

  expectPageError(exactMessage: string): void {
    if (!exactMessage.trim()) throw new Error('Expected page error must be a non-empty exact message.');
    if (this.pageErrors.includes(exactMessage)) {
      throw new Error('Expected page error must be declared before the error occurs.');
    }
    this.addRuntimeExpectation({ kind: 'page-error', target: 'page', expected: exactMessage });
  }

  expectConsoleError(exactMessage: string): void {
    if (!exactMessage.trim()) throw new Error('Expected console error must be a non-empty exact message.');
    if (this.consoleErrors.some((message) => message === `error: ${exactMessage}`)) {
      throw new Error('Expected console error must be declared before the error occurs.');
    }
    this.addRuntimeExpectation({ kind: 'console-error', target: 'console', expected: exactMessage });
  }

  coverEnvironments(...environments: AuditEnvironment[]): void {
    if (parseAuditProjectMetadata(this.testInfo.project.metadata).mode === 'single-site') {
      throw new Error('Single-site evidence cannot claim paired environment coverage.');
    }
    if (environments.length === 0) throw new Error('coverEnvironments requires at least one environment.');
    for (const environment of environments) {
      if (environment !== 'candidate' && environment !== 'production') {
        throw new Error(`Unsupported covered environment: ${String(environment)}.`);
      }
      this.coveredEnvironmentSet.add(environment);
    }
  }

  environmentBaseURL(): string {
    return parseAuditProjectMetadata(this.testInfo.project.metadata).baseURL;
  }

  environmentPath(candidatePath: string): string | null {
    return resolveProjectPath(parseAuditProjectMetadata(this.testInfo.project.metadata), candidatePath);
  }

  private async holdInteractionVideo(
    phase: InteractionVideoPhase,
    targetPage: Page = this.page,
    label?: string,
  ): Promise<void> {
    const durationMs = interactionVideoDelayMs(this.evidencePolicy.mode, phase);
    if (durationMs === 0 || targetPage.isClosed()) return;
    try {
      // Hidden tooling pages must not be lengthened into plausible evidence.
      if (targetPage.url() === 'about:blank') return;
      verboseLog('VIDEO_HOLD', {
        auditId: this.definition?.id ?? 'UNMAPPED',
        phase,
        durationMs,
        page: label ?? 'primary',
        url: redactUrl(targetPage.url()),
      });
      await targetPage.waitForTimeout(durationMs);
    } catch (error) {
      // A navigation or popup can close the page between the action and its
      // evidence hold. That must not replace the assertion's real outcome.
      verboseLog('VIDEO_HOLD_SKIPPED', {
        auditId: this.definition?.id ?? 'UNMAPPED',
        phase,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async holdFinalVideoOutcome(): Promise<void> {
    await this.holdInteractionVideo('final-outcome');
  }

  async holdSecondaryPageOutcome(targetPage: Page, label: string): Promise<void> {
    await this.holdInteractionVideo('secondary-outcome', targetPage, label);
  }

  async goto(candidatePath: string): Promise<void> {
    const resolved = this.environmentPath(candidatePath);
    if (resolved === null) {
      throw new Error(`No production-baseline equivalent is registered for ${candidatePath}.`);
    }
    verboseLog('NAVIGATION', { candidatePath, resolvedPath: resolved, baseURL: this.environmentBaseURL() });
    await this.page.goto(resolved, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(async () => {
      if ('fonts' in document) await document.fonts.ready;
    });
    await this.holdInteractionVideo('initial-state');
  }

  private async recordedStep<T>(
    name: string,
    expected: string,
    action: () => Promise<T>,
    interactionAction: boolean,
  ): Promise<T> {
    return base.step(name, async () => {
      if (interactionAction) this.interactionActionStepCount += 1;
      verboseLog('STEP_START', { auditId: this.definition?.id ?? 'UNMAPPED', name, expected });
      const record: AuditStepRecord = {
        name,
        expected,
        kind: interactionAction ? 'interaction' : 'runtime-health',
        startedAt: timestamp(),
        finishedAt: '',
        status: 'passed',
      };
      try {
        await this.holdInteractionVideo('before-action');
        const value = await action();
        await this.holdInteractionVideo('response');
        record.finishedAt = timestamp();
        this.steps.push(record);
        verboseLog('STEP_PASS', { auditId: this.definition?.id ?? 'UNMAPPED', name });
        return value;
      } catch (error) {
        await this.holdInteractionVideo('response');
        record.finishedAt = timestamp();
        record.status = 'failed';
        record.detail = error instanceof Error ? error.message : String(error);
        this.steps.push(record);
        verboseLog('STEP_FAIL', { auditId: this.definition?.id ?? 'UNMAPPED', name, detail: record.detail });
        throw error;
      }
    });
  }

  async step<T>(name: string, expected: string, action: () => Promise<T>): Promise<T> {
    return this.recordedStep(name, expected, action, true);
  }

  observe(label: string, value: AuditObservation['value'], expected?: string): void {
    const observation: AuditObservation = { label, value, timestamp: timestamp() };
    if (expected !== undefined) observation.expected = expected;
    this.observations.push(observation);
  }

  finding(finding: AuditFinding): void {
    this.findings.push(finding);
  }

  async attachJson(name: string, value: unknown): Promise<void> {
    await this.attachStructuredJson(name, value);
  }

  private async attachStructuredJson(name: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    if (bytes.length < 2 || bytes.length > MAX_STRUCTURED_EVIDENCE_BYTES) {
      throw new Error(`Structured evidence ${name} is empty or exceeds the ${MAX_STRUCTURED_EVIDENCE_BYTES}-byte per-file bound.`);
    }
    const occurrence = this.structuredAttachmentOccurrences.get(name) ?? 0;
    this.structuredAttachmentOccurrences.set(name, occurrence + 1);
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'evidence';
    const target = this.testInfo.outputPath('structured-evidence', `${safeName}-${occurrence}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
    try {
      await this.testInfo.attach(name, { path: target, contentType: 'application/json' });
    } finally {
      // Playwright copies path attachments into its owned attachment directory.
      await fs.rm(target, { force: true });
    }
  }

  async attachVisual(
    name: string,
    attachment: { path?: string; body?: Buffer; contentType: `image/${string}` | `video/${string}` },
    context: {
      attachmentKey?: string;
      comparisonGroup?: string;
      memberRole?: Exclude<GalleryMemberRole, 'single' | 'unknown'>;
      observedState: string;
      rationale: string;
      route?: string;
      capturedAt?: string;
      derivativeOf?: string;
    },
  ): Promise<void> {
    const occurrence = this.galleryAttachmentOccurrences.get(name) ?? 0;
    this.galleryAttachmentOccurrences.set(name, occurrence + 1);
    await this.testInfo.attach(name, attachment);
    const route = normalizeGalleryRoute(context.route ?? this.page.url());
    const observedState = boundedGalleryText(context.observedState);
    const rationale = boundedGalleryText(context.rationale);
    const metadata: GalleryCaptureMetadata = {
      schemaVersion: 1,
      attachmentName: name,
      attachmentOccurrence: occurrence,
      attachmentKey: boundedGalleryText(context.attachmentKey, 300) ?? `${name}#${occurrence}`,
      ...(context.comparisonGroup ? { comparisonGroup: boundedGalleryText(context.comparisonGroup, 300) ?? context.comparisonGroup } : {}),
      ...(context.memberRole ? { memberRole: context.memberRole } : {}),
      capturedAt: context.capturedAt ?? timestamp(),
      ...(route ? { route } : {}),
      ...(observedState ? { observedState } : {}),
      ...(rationale ? { rationale } : {}),
      ...(this.page.viewportSize() ? { viewport: this.page.viewportSize()! } : {}),
      ...(context.derivativeOf ? { derivativeOf: context.derivativeOf } : {}),
    };
    await this.testInfo.attach(`gallery-capture-metadata-${name}-${occurrence}`, {
      body: Buffer.from(JSON.stringify(metadata)),
      contentType: GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
    });
  }

  recordApiResponse(response: APIResponse, method: string, durationMs: number): void {
    const firstParty = this.isFirstParty(response.url());
    const record = {
      url: redactUrl(response.url()),
      method,
      resourceType: 'api',
      status: response.status(),
      contentType: response.headers()['content-type'] ?? null,
      fromServiceWorker: false,
      firstParty,
    };
    this.httpResponses.push(record);
    this.markRuntimeActivity();
    verboseLog('HTTP', { ...record, durationMs });
    const expected = firstParty
      && this.matchRuntimeExpectation('response-status', redactUrl(response.url()), response.status());
    if (firstParty && response.status() >= 400 && !expected) {
      this.badResponses.push({ url: record.url, status: response.status() });
    }
  }

  async checkpoint(name: string, options: { fullPage?: boolean } = {}): Promise<string> {
    name = assertStaticCheckpoint(this.evidencePolicy, name);
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = this.testInfo.outputPath(`${safeName || 'checkpoint'}.png`);
    const attachmentName = `checkpoint-${safeName || 'page'}`;
    const attachmentOccurrence = this.galleryAttachmentOccurrences.get(attachmentName) ?? 0;
    await this.page.screenshot({
      path,
      fullPage: options.fullPage ?? false,
      animations: 'disabled',
      caret: 'hide',
    });
    await this.attachVisual(
      attachmentName,
      { path, contentType: 'image/png' },
      {
        attachmentKey: attachmentName,
        observedState: `The ${name} checkpoint is visible.`,
        rationale: this.evidencePolicy.rationale,
      },
    );
    const project = parseAuditProjectMetadata(this.testInfo.project.metadata);
    if (project.mode === 'single-site') {
      const target = SINGLE_SITE_LOCAL_AUDIT_TARGETS.find(({ id }) => id === this.testInfo.project.name);
      const definition = this.currentDefinition;
      const viewport = this.page.viewportSize();
      if (!target || !definition || !viewport) {
        throw new Error('Single-site visual checkpoint lacks its target, Audit Definition, or viewport.');
      }
      const runnerImageDigest = runnerRevisionDigest(process.env.AUDIT_RUNNER_REVISION);
      const renderingState = await this.page.evaluate(() => ({
        devicePixelRatio: window.devicePixelRatio,
        route: `${window.location.pathname}${window.location.search}`,
        theme: document.documentElement.dataset.theme
          ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
        fonts: [...document.fonts].map((font) => ({
          family: font.family,
          style: font.style,
          weight: font.weight,
          stretch: font.stretch,
          status: font.status,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }));
      const browserVersion = this.page.context().browser()?.version() ?? 'unknown';
      const identity = parseVisualBaselineIdentity({
        schemaVersion: 1,
        mode: 'single-site',
        deploymentRole: project.deploymentRole,
        route: renderingState.route,
        targetId: target.id,
        viewport,
        theme: String(renderingState.theme).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-') || 'unknown',
        auditId: definition.id,
        auditDefinitionDigest: visualBaselineDigest(definition),
        capturePoint: safeName || 'checkpoint',
        browser: {
          engine: target.engine,
          product: target.browserProduct,
          version: browserVersion,
          build: `${target.browserProduct}-${browserVersion}`,
        },
        rendering: {
          devicePixelRatio: renderingState.devicePixelRatio,
          captureContractRevision: 'single-site-static-checkpoint-v1',
          runnerImageDigest,
          fontPackDigest: visualBaselineDigest(renderingState.fonts),
        },
      });
      const metadata = {
        schemaVersion: 1,
        kind: 'single-site-visual-capture',
        attachmentName,
        attachmentOccurrence,
        identity,
        identityKey: visualBaselineIdentityKey(identity),
        slotKey: visualBaselineSlotKey(identity),
      };
      await this.testInfo.attach(`visual-baseline-capture-${safeName || 'page'}`, {
        body: Buffer.from(JSON.stringify(metadata)),
        contentType: VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
      });
    }
    this.checkpointCount += 1;
    return path;
  }

  async inspectPage(): Promise<PageInspection> {
    const evaluated = await this.page.evaluate(() => {
      const root = document.documentElement;
      const viewportWidth = root.clientWidth;
      const brokenImages = [...document.images]
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src);
      const selectorFor = (element: Element): string => {
        const segments: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            segments.unshift(`${tag}#${CSS.escape(current.id)}`);
            break;
          }
          const parent: Element | null = current.parentElement;
          if (!parent) {
            segments.unshift(tag);
            break;
          }
          const sameTagSiblings = [...parent.children].filter((sibling) => sibling.tagName === current!.tagName);
          const index = sameTagSiblings.indexOf(current) + 1;
          segments.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
          if (segments.length >= 6) break;
        }
        return segments.join(' > ');
      };
      const nearestScrollOwnerFor = (element: Element, box: DOMRect) => {
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== root) {
          const style = window.getComputedStyle(ancestor);
          if (/(?:auto|scroll|hidden|clip)/.test(style.overflowX)) {
            const ancestorBox = ancestor.getBoundingClientRect();
            if (ancestor.scrollWidth > ancestor.clientWidth + 1
              || box.left < ancestorBox.left - 1
              || box.right > ancestorBox.right + 1) {
              return {
                element: ancestor,
                selector: selectorFor(ancestor),
                left: ancestorBox.left,
                right: ancestorBox.right,
                clientWidth: ancestor.clientWidth,
                scrollWidth: ancestor.scrollWidth,
                overflowX: style.overflowX,
              };
            }
          }
          ancestor = ancestor.parentElement;
        }
        return null;
      };
      const rawCandidates = root.scrollWidth <= viewportWidth + 1
        ? []
        : [document.body, ...document.body.querySelectorAll<HTMLElement>('*')].flatMap((element) => {
            const style = window.getComputedStyle(element);
            const box = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || box.width <= 0 || box.height <= 0) return [];
            const scrollOwner = nearestScrollOwnerFor(element, box);
            const selector = selectorFor(element);
            let selectorMatchCount = 0;
            try {
              selectorMatchCount = document.querySelectorAll(selector).length;
            } catch {
              selectorMatchCount = 0;
            }
            return [{
              selector,
              selectorMatchCount,
              tagName: element.tagName.toLowerCase(),
              text: (element.getAttribute('aria-label') || element.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160),
              left: box.left,
              right: box.right,
              width: box.width,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              overflowX: style.overflowX,
              position: style.position,
              containedByScrollOwner: scrollOwner !== null,
              nearestScrollOwner: scrollOwner === null ? null : {
                selector: scrollOwner.selector,
                left: Math.round(scrollOwner.left * 100) / 100,
                right: Math.round(scrollOwner.right * 100) / 100,
                clientWidth: scrollOwner.clientWidth,
                scrollWidth: scrollOwner.scrollWidth,
                overflowX: scrollOwner.overflowX,
              },
            }];
          });
      return {
        base: {
          url: window.location.href,
          title: document.title,
          h1Count: [...document.querySelectorAll('h1')].filter((heading) => {
            const style = window.getComputedStyle(heading);
            const box = heading.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
          }).length,
          horizontalOverflowPx: Math.max(0, root.scrollWidth - viewportWidth),
          brokenImages,
          documentHeight: root.scrollHeight,
          viewportWidth,
          viewportHeight: root.clientHeight,
          canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
          robots: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? null,
          description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? null,
          themeMode: root.dataset.themeMode ?? null,
        },
        rawCandidates,
      };
    });
    const overflow = classifyHorizontalOverflowCandidates(
      evaluated.base.horizontalOverflowPx,
      evaluated.base.viewportWidth,
      evaluated.rawCandidates,
    );
    const inspection: PageInspection = {
      ...evaluated.base,
      horizontalOverflowElements: overflow.elements,
      horizontalOverflowCandidateCount: overflow.candidateCount,
      horizontalOverflowTruncated: overflow.truncated,
    };
    this.pageInspections.push(inspection);
    return inspection;
  }

  private async waitForRuntimeQuiet(quietWindowMs = 350, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - this.lastRuntimeActivityAt;
      if (this.pendingFirstPartyRequests.size === 0 && quietFor >= quietWindowMs) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    const pending = [...this.pendingFirstPartyRequests].map((request) => redactUrl(request.url()));
    throw new Error(
      `Browser runtime did not reach a ${quietWindowMs}ms quiet window within ${timeoutMs}ms. `
      + `Pending first-party requests: ${pending.length > 0 ? pending.join(', ') : 'none'}.`,
    );
  }

  private synchronizeThirdPartyTelemetryDiagnostics(
    diagnostics: AuditThirdPartyTelemetryDiagnostic[],
  ): void {
    const deduplicated = [...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values()];
    this.thirdPartyTelemetryDiagnostics.splice(0, this.thirdPartyTelemetryDiagnostics.length, ...deduplicated);
    const label = 'Expected third-party telemetry diagnostics';
    const existingObservation = this.observations.find((observation) => observation.label === label);
    if (deduplicated.length > 0) {
      if (existingObservation) {
        existingObservation.value = deduplicated.length;
        existingObservation.expected = 'Classified separately; first-party runtime defects remain release blocking';
      } else {
        this.observations.push({
          label,
          value: deduplicated.length,
          expected: 'Classified separately; first-party runtime defects remain release blocking',
          timestamp: timestamp(),
        });
      }
    }
    for (const diagnostic of deduplicated) {
      const key = JSON.stringify(diagnostic);
      if (this.loggedTelemetryDiagnostics.has(key)) continue;
      this.loggedTelemetryDiagnostics.add(key);
      verboseLog('THIRD_PARTY_TELEMETRY', { ...diagnostic });
    }
  }

  private async assertRuntimeHealthyState(): Promise<void> {
    await this.waitForRuntimeQuiet();
    const telemetryDiagnostics = this.httpResponses
      .map((response) => expectedThirdPartyTelemetryResponseDiagnostic(response))
      .filter((diagnostic): diagnostic is AuditThirdPartyTelemetryDiagnostic => diagnostic !== null);
    const consoleEvents = this.consoleErrorEvents.filter((event) => !this.isExpectedResponseConsoleDerivative(event));
    const directConsoleDiagnostics = consoleEvents.map((event) => classifyExpectedThirdPartyTelemetryDiagnostic({
      text: event.text,
      sourceUrl: event.sourceUrl,
      surface: 'console-error',
    }, this.httpResponses));
    const directPageDiagnostics = this.pageErrorEvents.map((event) => classifyExpectedThirdPartyTelemetryDiagnostic({
      ...event,
      surface: 'page-error',
    }, this.httpResponses));
    const cloudflareRumCausallyObserved = [
      ...telemetryDiagnostics,
      ...directConsoleDiagnostics,
      ...directPageDiagnostics,
    ].some((diagnostic) => diagnostic?.provider === 'cloudflare-rum');
    const consoleErrors: string[] = [];
    for (const [index, event] of consoleEvents.entries()) {
      const diagnostic = directConsoleDiagnostics[index] ?? classifyExpectedThirdPartyTelemetryDiagnostic({
        text: event.text,
        sourceUrl: event.sourceUrl,
        surface: 'console-error',
      }, this.httpResponses, { cloudflareRumCausallyObserved });
      if (diagnostic) telemetryDiagnostics.push(diagnostic);
      else consoleErrors.push(event.rendered);
    }
    const pageErrors: string[] = [];
    for (const [index, event] of this.pageErrorEvents.entries()) {
      const diagnostic = directPageDiagnostics[index] ?? classifyExpectedThirdPartyTelemetryDiagnostic({
        ...event,
        surface: 'page-error',
      }, this.httpResponses, { cloudflareRumCausallyObserved });
      if (diagnostic) telemetryDiagnostics.push(diagnostic);
      else pageErrors.push(event.text);
    }
    this.consoleErrors.splice(0, this.consoleErrors.length, ...unique(consoleErrors));
    this.pageErrors.splice(0, this.pageErrors.length, ...unique(pageErrors));
    this.synchronizeThirdPartyTelemetryDiagnostics(telemetryDiagnostics);
    const unmetExpectations = this.runtimeExpectations.filter(({ matched }) => !matched);
    expect(unmetExpectations, 'Declared expected runtime events must actually occur').toEqual([]);
    expect(pageErrors, 'Unhandled page errors').toEqual([]);
    expect(this.failedRequests, 'Failed first-party requests').toEqual([]);
    expect(this.badResponses, 'First-party responses with error status').toEqual([]);
    expect(consoleErrors, 'Browser console errors').toEqual([]);
  }

  private isExpectedResponseConsoleDerivative(event: { text: string; locationUrl: string | null }): boolean {
    const expectation = expectedResponseConsoleDerivative(event, this.runtimeExpectations);
    if (expectation) {
      verboseLog('EXPECTED_RUNTIME_CONSOLE_DERIVATIVE', {
        target: event.locationUrl,
        status: expectation.expected,
        message: event.text,
      });
    }
    return expectation !== null;
  }

  async assertRuntimeHealthy(): Promise<void> {
    await this.recordedStep('Inspect browser runtime health', 'No unexpected first-party runtime, request, or response failures occur.', async () => {
      await this.assertRuntimeHealthyState();
    }, false);
  }

  async assertFinalRuntimeHealthy(): Promise<void> {
    await this.assertRuntimeHealthyState();
  }

  async finalize(): Promise<void> {
    let policyError: Error | null = null;
    if (
      this.evidencePolicy.mode === 'interaction-video'
      && this.testInfo.status === 'passed'
      && this.interactionActionStepCount === 0
    ) {
      policyError = new Error(
        `Interaction test "${this.testInfo.title}" passed without an audit.step action/response checkpoint. `
        + 'Put the observable user action and assertion inside audit.step(...).',
      );
    }
    if (
      this.evidencePolicy.mode === 'static-screenshot'
      && this.testInfo.status === 'passed'
      && this.checkpointCount === 0
    ) {
      policyError = new Error(
        `Static test "${this.testInfo.title}" passed without a purposeful audit.checkpoint(...) capture.`,
      );
    }
    const project = parseAuditProjectMetadata(this.testInfo.project.metadata);
    // Legacy report readers still require the compatibility environment while
    // Single-site report branching is introduced. The explicit mode, role,
    // base URL, and authority below remain the execution truth.
    const compatibilityEnvironment: AuditEnvironment = project.mode === 'comparative'
      ? project.environment
      : project.deploymentRole === 'preview' ? 'candidate' : 'production';
    const viewport = this.page.viewportSize();
    const idFromTitle = firstBracketedAuditId(this.testInfo.title);
    const record: AuditEvidenceRecord = {
      schemaVersion: 1,
      ...(this.caseId ? { caseId: this.caseId } : {}),
      auditId: this.definition?.id ?? idFromTitle ?? 'UNMAPPED',
      definition: this.definition,
      evidencePolicy: this.evidencePolicy,
      environment: compatibilityEnvironment,
      ...(project.mode === 'comparative'
        ? { coveredEnvironments: [...this.coveredEnvironmentSet].sort() }
        : {
            mode: 'single-site' as const,
            deploymentRole: project.deploymentRole,
            evidenceAuthority: project.evidenceAuthority,
          }),
      baseURL: project.baseURL,
      project: this.testInfo.project.name,
      browser: project.browserLabel,
      viewport,
      timezone: String(this.testInfo.project.use.timezoneId ?? 'system'),
      startedAt: this.startedAt,
      finishedAt: timestamp(),
      steps: this.steps,
      observations: this.observations,
      findings: this.findings,
      pageInspections: this.pageInspections,
      consoleErrors: unique(this.consoleErrors),
      consoleWarnings: unique(this.consoleWarnings),
      pageErrors: unique(this.pageErrors),
      httpResponses: this.httpResponses,
      failedRequests: this.failedRequests,
      badResponses: this.badResponses,
      runtimeExpectations: this.runtimeExpectations.map((expectation) => ({ ...expectation })),
      thirdPartyTelemetryDiagnostics: this.thirdPartyTelemetryDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
    await this.attachStructuredJson('audit-result', record);
    const auditSummary = Buffer.from(JSON.stringify({
      schemaVersion: record.schemaVersion,
      ...(record.caseId ? { caseId: record.caseId } : {}),
      auditId: record.auditId,
      ...(record.mode === 'single-site' ? {
        mode: record.mode,
        deploymentRole: record.deploymentRole,
        evidenceAuthority: record.evidenceAuthority,
      } : { coveredEnvironments: record.coveredEnvironments }),
      environment: record.environment,
      baseURL: record.baseURL,
      project: record.project,
      findings: record.findings,
      steps: record.steps,
    }));
    if (auditSummary.length > MAX_AUDIT_RESULT_SUMMARY_BYTES) {
      throw new Error(`Compact audit-result summary exceeds the ${MAX_AUDIT_RESULT_SUMMARY_BYTES}-byte decision bound.`);
    }
    await this.testInfo.attach('audit-result-summary', {
      body: auditSummary,
      contentType: 'application/json',
    });
    if (this.definition?.evidence.includes('network')) {
      await this.attachStructuredJson('network-evidence', {
        httpResponses: record.httpResponses,
        failedRequests: record.failedRequests,
        badResponses: record.badResponses,
        thirdPartyTelemetryDiagnostics: record.thirdPartyTelemetryDiagnostics,
      });
    }
    verboseLog('TEST_FINISH', {
      auditId: record.auditId,
      project: record.project,
      steps: record.steps.length,
      findings: record.findings.length,
      httpResponses: record.httpResponses.length,
      consoleErrors: record.consoleErrors.length,
      thirdPartyTelemetryDiagnostics: record.thirdPartyTelemetryDiagnostics?.length ?? 0,
      failedRequests: record.failedRequests.length,
      evidencePolicy: record.evidencePolicy,
    });
    if (policyError) throw policyError;
  }
}

export type { AuditApplicability } from '../audit/types.js';

interface AuditProjectContext {
  name: string;
  metadata: AuditProjectMetadata;
}

export function auditApplies(applicability: AuditApplicability, project: AuditProjectContext): boolean {
  if (project.metadata.mode === 'single-site') {
    const target = SINGLE_SITE_LOCAL_AUDIT_TARGETS.find(({ id }) => id === project.name);
    if (!target) throw new Error(`Playwright project ${project.name} is absent from the validated Single-site target registry.`);
    return singleSiteTargetMatchesAuditApplicability(applicability, target, LOCAL_AUDIT_TARGETS);
  }
  const target = LOCAL_AUDIT_TARGETS.find(({ id }) => id === project.name);
  if (!target) throw new Error(`Playwright project ${project.name} is absent from the validated audit target registry.`);
  return targetMatchesAuditApplicability(applicability, target);
}

const auditedBase = base.extend<{ audit: AuditRun }, { auditProject: AuditProjectContext }>({
  auditProject: [async ({}, use, workerInfo) => {
    await use({
      name: workerInfo.project.name,
      metadata: parseAuditProjectMetadata(workerInfo.project.metadata),
    });
  }, { scope: 'worker' }],
  audit: async ({ page }, use, testInfo) => {
    const evidencePolicy = parseEvidencePolicyAnnotation(testInfo.annotations);
    if (!evidencePolicy) {
      throw new Error(
        `Test "${testInfo.title}" is missing its explicit ${AUDIT_EVIDENCE_POLICY_ANNOTATION} declaration. `
        + 'Register audits with interactionTest(...) or staticTest(...).',
      );
    }
    const applicability = parseAuditApplicabilityAnnotation(testInfo.annotations);
    if (!applicability) {
      throw new Error(
        `Test "${testInfo.title}" is missing its exact ${AUDIT_APPLICABILITY_ANNOTATION} declaration.`,
      );
    }
    const run = new AuditRun(page, testInfo, evidencePolicy);
    await use(run);
    await run.holdFinalVideoOutcome();
    let finalRuntimeError: unknown;
    try {
      await run.assertFinalRuntimeHealthy();
    } catch (error) {
      finalRuntimeError = error;
    }
    let finalizationError: unknown;
    try {
      await run.finalize();
    } catch (error) {
      finalizationError = error;
    }
    if (finalRuntimeError) throw finalRuntimeError;
    if (finalizationError) throw finalizationError;
  },
});

const interactionVideo = {
  mode: 'on' as const,
  size: { width: 800, height: 600 },
  show: {
    actions: { duration: 700, position: 'bottom-right' as const, fontSize: 14, cursor: 'pointer' as const },
    test: { level: 'step' as const, position: 'top-left' as const, fontSize: 14 },
  },
};
const interactionBase = auditedBase.extend({
  video: [interactionVideo, { scope: 'worker' }],
});
const staticBase = auditedBase.extend({
  video: ['off', { scope: 'worker' }],
});
const structuredBase = auditedBase.extend({
  video: ['off', { scope: 'worker' }],
});

function evidenceDetails(
  mode: AuditEvidenceMode,
  rationale: string,
  applicability: AuditApplicability,
  caseVariant?: string,
): {
  annotation: { type: string; description: string };
  applicabilityAnnotation: { type: string; description: string };
  annotations: Array<{ type: string; description: string }>;
  applicability: AuditApplicability;
  tag: string;
  caseVariant?: string;
} {
  const policy = createEvidencePolicy(mode, rationale);
  const annotation = {
    type: AUDIT_EVIDENCE_POLICY_ANNOTATION,
    description: serializeEvidencePolicy(policy),
  };
  const applicabilityAnnotation = {
    type: AUDIT_APPLICABILITY_ANNOTATION,
    description: applicability,
  };
  const normalizedCaseVariant = caseVariant?.trim();
  if (caseVariant !== undefined && !normalizedCaseVariant) throw new Error('Audit case variant must be non-empty when provided.');
  return {
    annotation,
    applicabilityAnnotation,
    annotations: [annotation, applicabilityAnnotation],
    applicability,
    tag: `@evidence-${mode}`,
    ...(normalizedCaseVariant ? { caseVariant: normalizedCaseVariant } : {}),
  };
}

type AuditEvidenceDetails = ReturnType<typeof evidenceDetails>;

export function interactionEvidence(
  rationale: string,
  applicability: AuditApplicability,
  caseVariant?: string,
): AuditEvidenceDetails {
  return evidenceDetails('interaction-video', rationale, applicability, caseVariant);
}

export function staticEvidence(rationale: string, applicability: AuditApplicability, caseVariant?: string): AuditEvidenceDetails {
  return evidenceDetails('static-screenshot', rationale, applicability, caseVariant);
}

export function structuredEvidence(rationale: string, applicability: AuditApplicability, caseVariant?: string): AuditEvidenceDetails {
  return evidenceDetails('structured-data', rationale, applicability, caseVariant);
}

export function standaloneStaticEvidence(
  rationale: string,
  applicability: AuditApplicability,
  oracleVariant: string,
): AuditEvidenceDetails & { oracleVariant: string } {
  const normalizedOracle = oracleVariant.trim();
  if (!normalizedOracle) throw new Error('Standalone static evidence requires a named Product Oracle variant.');
  return { ...evidenceDetails('static-screenshot', rationale, applicability), oracleVariant: normalizedOracle };
}

type InteractionBody = Parameters<typeof interactionBase>[2];

function declaredAuditCase(
  title: string,
  details: AuditEvidenceDetails & { oracleVariant?: string },
  mode: 'single-site' | 'comparative',
): { caseId: string; tag: string } | null {
  const auditId = firstBracketedAuditId(title);
  if (!auditId) throw new Error(`Audit title must begin with a bracketed Audit ID: ${title}`);
  const caseId = resolveDeclaredAuditCaseId(executableCaseRegistry, {
    mode,
    auditId,
    applicability: details.applicability,
    ...(details.caseVariant ? { caseVariant: details.caseVariant } : {}),
    ...(details.oracleVariant ? { oracleVariant: details.oracleVariant } : {}),
  });
  return caseId ? { caseId, tag: auditCaseTag(caseId) } : null;
}

function registrationDetails(
  details: AuditEvidenceDetails,
  auditCase: { caseId: string; tag: string } | null,
): { annotation: Array<{ type: string; description: string }>; tag: string | string[] } {
  return {
    annotation: auditCase
      ? [...details.annotations, { type: AUDIT_CASE_ID_ANNOTATION, description: auditCase.caseId }]
      : details.annotations,
    tag: auditCase ? [details.tag, auditCase.tag] : details.tag,
  };
}

export function interactionTest(
  title: string,
  details: AuditEvidenceDetails,
  body: InteractionBody,
): void {
  const runMode = activeRunMode();
  const auditCase = declaredAuditCase(title, details, runMode);
  if (runMode === 'single-site' && !auditCase) return;
  interactionBase.describe(() => {
    interactionBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    interactionBase(title, registrationDetails(details, auditCase), body);
  });
}

type StaticBody = Parameters<typeof staticBase>[2];

export function staticTest(title: string, details: AuditEvidenceDetails, body: StaticBody): void {
  const runMode = activeRunMode();
  const auditCase = declaredAuditCase(title, details, runMode);
  if (runMode === 'single-site' && !auditCase) return;
  staticBase.describe(() => {
    staticBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    staticBase(title, registrationDetails(details, auditCase), body);
  });
}

export function inventoriedStaticTest(
  title: string,
  details: AuditEvidenceDetails,
  caseId: string,
  body: StaticBody,
): void {
  if (activeRunMode() !== 'single-site') return;
  const normalizedCaseId = caseId.trim();
  if (!normalizedCaseId) throw new Error('An inventoried static test requires its frozen dynamic case ID.');
  staticBase.describe(() => {
    staticBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    staticBase(title, registrationDetails(details, {
      caseId: normalizedCaseId,
      tag: auditCaseTag(normalizedCaseId),
    }), body);
  });
}

export function standaloneStaticTest(
  title: string,
  details: AuditEvidenceDetails & { oracleVariant: string },
  body: StaticBody,
): void {
  const runMode = activeRunMode();
  const auditCase = declaredAuditCase(title, details, runMode);
  if (runMode === 'single-site' && !auditCase) {
    throw new Error(`Standalone Single-site declaration is absent from the generated executable-case registry: ${title}.`);
  }
  staticBase.describe(() => {
    staticBase.skip(
      () => process.env.AUDIT_RUN_MODE !== 'single-site',
      'This independent Product Oracle executes only in Single-site Audit mode.',
    );
    staticBase(title, registrationDetails(details, auditCase), body);
  });
}

type StructuredBody = Parameters<typeof structuredBase>[2];

export function structuredTest(title: string, details: AuditEvidenceDetails, body: StructuredBody): void {
  const runMode = activeRunMode();
  const auditCase = declaredAuditCase(title, details, runMode);
  if (runMode === 'single-site' && !auditCase) return;
  structuredBase.describe(() => {
    structuredBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    structuredBase(title, registrationDetails(details, auditCase), body);
  });
}

export const test = auditedBase;

export { expect };
