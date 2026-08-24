import { expect, test as base, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { ALL_AUDIT_BY_ID } from '../audit/definitions.js';
import { ENVIRONMENTS, projectMetadata, resolveEnvironmentPath } from '../audit/environments.js';
import { firstBracketedAuditId } from '../audit/audit-id.js';
import { interactionVideoDelayMs, type InteractionVideoPhase } from '../audit/interaction-pacing.js';
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
import { LOCAL_AUDIT_TARGETS } from '../audit/targets.js';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  boundedGalleryText,
  normalizeGalleryRoute,
  type GalleryCaptureMetadata,
  type GalleryMemberRole,
} from '../shared/gallery-contract.mjs';
import { targetMatchesAuditApplicability } from '../shared/target-applicability.mjs';
import type {
  AuditDefinition,
  AuditApplicability,
  AuditEvidenceRecord,
  AuditEvidenceMode,
  AuditEvidencePolicy,
  AuditFinding,
  AuditObservation,
  AuditRuntimeExpectation,
  AuditStepRecord,
  AuditEnvironment,
  PageInspection,
} from '../audit/types.js';

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

function verboseLog(event: string, detail: Record<string, unknown>): void {
  if (process.env.AUDIT_VERBOSE !== '1') return;
  process.stdout.write(`${new Date().toISOString()} [AUDIT_${event}] ${JSON.stringify(detail)}\n`);
}

export class AuditRun {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly evidencePolicy: AuditEvidencePolicy;
  private currentDefinition: AuditDefinition | null;
  private checkpointCount = 0;
  private interactionActionStepCount = 0;
  private readonly coveredEnvironmentSet = new Set<AuditEnvironment>();
  private readonly pendingFirstPartyRequests = new Set<Request>();
  private readonly runtimeExpectations: AuditRuntimeExpectation[] = [];
  private lastRuntimeActivityAt = Date.now();
  private readonly galleryAttachmentOccurrences = new Map<string, number>();
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
  private readonly consoleErrorEvents: Array<{ rendered: string; text: string; locationUrl: string | null }> = [];

  constructor(page: Page, testInfo: TestInfo, evidencePolicy: AuditEvidencePolicy) {
    this.page = page;
    this.testInfo = testInfo;
    this.evidencePolicy = evidencePolicy;
    const auditId = firstBracketedAuditId(testInfo.title);
    this.currentDefinition = auditId ? (ALL_AUDIT_BY_ID.get(auditId) ?? null) : null;
    this.coveredEnvironmentSet.add(projectMetadata(testInfo.project.metadata).environment);
    verboseLog('TEST_START', {
      auditId: auditId ?? 'UNMAPPED',
      project: testInfo.project.name,
      title: testInfo.title,
      evidencePolicy,
    });

    page.on('console', (message) => {
      const rendered = `${message.type()}: ${message.text()}`;
      if (message.type() === 'error' && !this.matchRuntimeExpectation('console-error', 'console', message.text())) {
        this.consoleErrors.push(rendered);
        const locationUrl = message.location().url;
        this.consoleErrorEvents.push({
          rendered,
          text: message.text(),
          locationUrl: locationUrl && this.isFirstParty(locationUrl) ? redactUrl(locationUrl) : null,
        });
      }
      if (message.type() === 'warning') this.consoleWarnings.push(rendered);
      if (message.type() === 'error' || message.type() === 'warning') this.markRuntimeActivity();
    });
    page.on('pageerror', (error) => {
      if (!this.matchRuntimeExpectation('page-error', 'page', error.message)) this.pageErrors.push(error.message);
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
    if (environments.length === 0) throw new Error('coverEnvironments requires at least one environment.');
    for (const environment of environments) {
      if (environment !== 'candidate' && environment !== 'production') {
        throw new Error(`Unsupported covered environment: ${String(environment)}.`);
      }
      this.coveredEnvironmentSet.add(environment);
    }
  }

  environmentBaseURL(): string {
    const metadata = projectMetadata(this.testInfo.project.metadata);
    return ENVIRONMENTS[metadata.environment].baseURL;
  }

  environmentPath(candidatePath: string): string | null {
    const metadata = projectMetadata(this.testInfo.project.metadata);
    return resolveEnvironmentPath(metadata.environment, candidatePath);
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
    await this.testInfo.attach(name, {
      body: Buffer.from(JSON.stringify(value, null, 2)),
      contentType: 'application/json',
    });
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
    await this.page.screenshot({
      path,
      fullPage: options.fullPage ?? false,
      animations: 'disabled',
      caret: 'hide',
    });
    await this.attachVisual(
      `checkpoint-${safeName || 'page'}`,
      { path, contentType: 'image/png' },
      {
        attachmentKey: `checkpoint-${safeName || 'page'}`,
        observedState: `The ${name} checkpoint is visible.`,
        rationale: this.evidencePolicy.rationale,
      },
    );
    this.checkpointCount += 1;
    return path;
  }

  async inspectPage(): Promise<PageInspection> {
    const inspection = await this.page.evaluate(() => {
      const root = document.documentElement;
      const brokenImages = [...document.images]
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src);
      return {
        url: window.location.href,
        title: document.title,
        h1Count: [...document.querySelectorAll('h1')].filter((heading) => {
          const style = window.getComputedStyle(heading);
          const box = heading.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        }).length,
        horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
        brokenImages,
        documentHeight: root.scrollHeight,
        viewportWidth: root.clientWidth,
        viewportHeight: root.clientHeight,
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
        robots: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? null,
        description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? null,
        themeMode: root.dataset.themeMode ?? null,
      };
    });
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

  private async assertRuntimeHealthyState(): Promise<void> {
    await this.waitForRuntimeQuiet();
    const retainedConsoleErrors = this.consoleErrorEvents.filter((event) => !this.isExpectedResponseConsoleDerivative(event));
    this.consoleErrors.splice(0, this.consoleErrors.length, ...unique(retainedConsoleErrors.map(({ rendered }) => rendered)));
    this.pageErrors.splice(0, this.pageErrors.length, ...unique(this.pageErrors));
    const auditId = this.definition?.id ?? 'UNMAPPED';
    const allRuntimeMessages = [...this.pageErrors, ...this.consoleErrors];
    const cloudflareRumFailure = allRuntimeMessages.some((message) => /cloudflareinsights\.com\/cdn-cgi\/rum/i.test(message))
      || this.httpResponses.some(({ firstParty, status, url }) => !firstParty && status >= 400 && /cloudflareinsights\.com\/cdn-cgi\/rum/i.test(url));
    const isKnownAnalyticsNoise = (message: string): boolean => {
      if (/cloudflareinsights\.com\/cdn-cgi\/rum/i.test(message)) return true;
      if (cloudflareRumFailure && /(?:Failed to load resource:\s*(?:net::ERR_FAILED|Origin https?:\/\/[^ ]+ is not allowed by Access-Control-Allow-Origin\. Status code: 404)|Origin https?:\/\/[^ ]+ is not allowed by Access-Control-Allow-Origin\. Status code: 404)/i.test(message)) return true;
      if (/Cookie [“\"]_ga(?:_[A-Z0-9]+)?[”\"] has been rejected for invalid domain/i.test(message)) return true;
      return false;
    };
    const pageErrors = auditId === 'REL-001'
      ? this.pageErrors
      : this.pageErrors.filter((message) => !isKnownAnalyticsNoise(message));
    const consoleErrors = auditId === 'REL-001'
      ? this.consoleErrors
      : this.consoleErrors.filter((message) => !isKnownAnalyticsNoise(message));
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
    const project = projectMetadata(this.testInfo.project.metadata);
    const viewport = this.page.viewportSize();
    const idFromTitle = firstBracketedAuditId(this.testInfo.title);
    const record: AuditEvidenceRecord = {
      schemaVersion: 1,
      auditId: this.definition?.id ?? idFromTitle ?? 'UNMAPPED',
      definition: this.definition,
      evidencePolicy: this.evidencePolicy,
      environment: project.environment,
      coveredEnvironments: [...this.coveredEnvironmentSet].sort(),
      baseURL: ENVIRONMENTS[project.environment].baseURL,
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
    };
    await this.testInfo.attach('audit-result', {
      body: Buffer.from(JSON.stringify(record, null, 2)),
      contentType: 'application/json',
    });
    if (this.definition?.evidence.includes('network')) {
      await this.testInfo.attach('network-evidence', {
        body: Buffer.from(JSON.stringify({
          httpResponses: record.httpResponses,
          failedRequests: record.failedRequests,
          badResponses: record.badResponses,
        }, null, 2)),
        contentType: 'application/json',
      });
    }
    verboseLog('TEST_FINISH', {
      auditId: record.auditId,
      project: record.project,
      steps: record.steps.length,
      findings: record.findings.length,
      httpResponses: record.httpResponses.length,
      consoleErrors: record.consoleErrors.length,
      failedRequests: record.failedRequests.length,
      evidencePolicy: record.evidencePolicy,
    });
    if (policyError) throw policyError;
  }
}

export type { AuditApplicability } from '../audit/types.js';

interface AuditProjectContext {
  name: string;
  metadata: ReturnType<typeof projectMetadata>;
}

export function auditApplies(applicability: AuditApplicability, project: AuditProjectContext): boolean {
  const target = LOCAL_AUDIT_TARGETS.find(({ id }) => id === project.name);
  if (!target) throw new Error(`Playwright project ${project.name} is absent from the validated audit target registry.`);
  return targetMatchesAuditApplicability(applicability, target);
}

const auditedBase = base.extend<{ audit: AuditRun }, { auditProject: AuditProjectContext }>({
  auditProject: [async ({}, use, workerInfo) => {
    await use({
      name: workerInfo.project.name,
      metadata: projectMetadata(workerInfo.project.metadata),
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
): {
  annotation: { type: string; description: string };
  applicabilityAnnotation: { type: string; description: string };
  annotations: Array<{ type: string; description: string }>;
  applicability: AuditApplicability;
  tag: string;
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
  return {
    annotation,
    applicabilityAnnotation,
    annotations: [annotation, applicabilityAnnotation],
    applicability,
    tag: `@evidence-${mode}`,
  };
}

type AuditEvidenceDetails = ReturnType<typeof evidenceDetails>;

export function interactionEvidence(
  rationale: string,
  applicability: AuditApplicability,
): AuditEvidenceDetails {
  return evidenceDetails('interaction-video', rationale, applicability);
}

export function staticEvidence(rationale: string, applicability: AuditApplicability): AuditEvidenceDetails {
  return evidenceDetails('static-screenshot', rationale, applicability);
}

export function structuredEvidence(rationale: string, applicability: AuditApplicability): AuditEvidenceDetails {
  return evidenceDetails('structured-data', rationale, applicability);
}

type InteractionBody = Parameters<typeof interactionBase>[2];

export function interactionTest(
  title: string,
  details: AuditEvidenceDetails,
  body: InteractionBody,
): void {
  interactionBase.describe(() => {
    interactionBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    interactionBase(title, { annotation: details.annotations, tag: details.tag }, body);
  });
}

type StaticBody = Parameters<typeof staticBase>[2];

export function staticTest(title: string, details: AuditEvidenceDetails, body: StaticBody): void {
  staticBase.describe(() => {
    staticBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    staticBase(title, { annotation: details.annotations, tag: details.tag }, body);
  });
}

type StructuredBody = Parameters<typeof structuredBase>[2];

export function structuredTest(title: string, details: AuditEvidenceDetails, body: StructuredBody): void {
  structuredBase.describe(() => {
    structuredBase.skip(
      ({ auditProject }) => !auditApplies(details.applicability, auditProject),
      `Audit evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    structuredBase(title, { annotation: details.annotations, tag: details.tag }, body);
  });
}

export const test = auditedBase;

export { expect };
