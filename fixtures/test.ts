import { expect, test as base, type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { ALL_AUDIT_BY_ID } from '../audit/definitions.js';
import { ENVIRONMENTS, projectMetadata, resolveEnvironmentPath } from '../audit/environments.js';
import { firstBracketedAuditId } from '../audit/audit-id.js';
import { interactionVideoDelayMs, type InteractionVideoPhase } from '../audit/interaction-pacing.js';
import {
  AUDIT_EVIDENCE_POLICY_ANNOTATION,
  createEvidencePolicy,
  parseEvidencePolicyAnnotation,
  serializeEvidencePolicy,
} from '../audit/evidence-policy.js';
import { assertAuditDefinition, auditDefinitionsEqual } from '../audit/plugins.js';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  boundedGalleryText,
  normalizeGalleryRoute,
  type GalleryCaptureMetadata,
  type GalleryMemberRole,
} from '../shared/gallery-contract.mjs';
import type {
  AuditDefinition,
  AuditEvidenceRecord,
  AuditEvidenceMode,
  AuditEvidencePolicy,
  AuditFinding,
  AuditObservation,
  AuditStepRecord,
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

  constructor(page: Page, testInfo: TestInfo, evidencePolicy: AuditEvidencePolicy) {
    this.page = page;
    this.testInfo = testInfo;
    this.evidencePolicy = evidencePolicy;
    const auditId = firstBracketedAuditId(testInfo.title);
    this.currentDefinition = auditId ? (ALL_AUDIT_BY_ID.get(auditId) ?? null) : null;
    verboseLog('TEST_START', {
      auditId: auditId ?? 'UNMAPPED',
      project: testInfo.project.name,
      title: testInfo.title,
      evidencePolicy,
    });

    page.on('console', (message) => {
      const rendered = `${message.type()}: ${message.text()}`;
      if (message.type() === 'error') this.consoleErrors.push(rendered);
      if (message.type() === 'warning') this.consoleWarnings.push(rendered);
    });
    page.on('pageerror', (error) => this.pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (!this.isFirstParty(request.url())) return;
      const failure = {
        url: redactUrl(request.url()),
        reason: request.failure()?.errorText ?? 'unknown request failure',
      };
      this.failedRequests.push(failure);
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
      verboseLog('HTTP', record);
      if (firstParty && response.status() >= 400) this.badResponses.push({ url: record.url, status: response.status() });
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

  async step<T>(name: string, expected: string, action: () => Promise<T>): Promise<T> {
    return base.step(name, async () => {
      verboseLog('STEP_START', { auditId: this.definition?.id ?? 'UNMAPPED', name, expected });
      const record: AuditStepRecord = {
        name,
        expected,
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
    verboseLog('HTTP', { ...record, durationMs });
    if (firstParty && response.status() >= 400) this.badResponses.push({ url: record.url, status: response.status() });
  }

  async checkpoint(name: string, options: { fullPage?: boolean } = {}): Promise<string> {
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

  private async ensureStaticCheckpoint(): Promise<void> {
    if (this.evidencePolicy.mode !== 'static-screenshot' || this.checkpointCount > 0) return;
    if (this.testInfo.attachments.some(({ contentType }) => contentType.startsWith('image/'))) return;
    if (this.page.isClosed()) return;
    try {
      if (this.page.url() === 'about:blank') return;
      await this.checkpoint('automatic-static-evidence');
    } catch (error) {
      verboseLog('STATIC_CHECKPOINT_FAILURE', {
        auditId: this.definition?.id ?? 'UNMAPPED',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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

  async assertRuntimeHealthy(): Promise<void> {
    await this.step('Inspect browser runtime health', 'No first-party runtime, request, or response failures occur.', async () => {
      this.consoleErrors.splice(0, this.consoleErrors.length, ...unique(this.consoleErrors));
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
      expect(pageErrors, 'Unhandled page errors').toEqual([]);
      expect(this.failedRequests, 'Failed first-party requests').toEqual([]);
      expect(this.badResponses, 'First-party responses with error status').toEqual([]);
      expect(consoleErrors, 'Browser console errors').toEqual([]);
    });
  }

  async finalize(): Promise<void> {
    if (
      this.evidencePolicy.mode === 'interaction-video'
      && this.testInfo.status === 'passed'
      && this.steps.length === 0
    ) {
      throw new Error(
        `Interaction test "${this.testInfo.title}" passed without an audit.step action/response checkpoint. `
        + 'Put the observable user action and assertion inside audit.step(...).',
      );
    }
    await this.ensureStaticCheckpoint();
    const project = projectMetadata(this.testInfo.project.metadata);
    const viewport = this.page.viewportSize();
    const idFromTitle = firstBracketedAuditId(this.testInfo.title);
    const record: AuditEvidenceRecord = {
      schemaVersion: 1,
      auditId: this.definition?.id ?? idFromTitle ?? 'UNMAPPED',
      definition: this.definition,
      evidencePolicy: this.evidencePolicy,
      environment: project.environment,
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
  }
}

export type InteractionApplicability =
  | 'all-projects'
  | 'candidate-projects'
  | 'candidate-non-tablet-projects'
  | 'candidate-chromium-projects'
  | 'candidate-desktop-chromium'
  | 'candidate-mobile-projects'
  | 'candidate-mobile-chromium';

interface AuditProjectContext {
  name: string;
  metadata: ReturnType<typeof projectMetadata>;
}

function interactionApplies(applicability: InteractionApplicability, project: AuditProjectContext): boolean {
  const candidate = project.metadata.environment === 'candidate';
  const chromium = project.name.includes('chromium');
  switch (applicability) {
    case 'all-projects': return true;
    case 'candidate-projects': return candidate;
    case 'candidate-non-tablet-projects': return candidate && project.metadata.deviceClass !== 'tablet';
    case 'candidate-chromium-projects': return candidate && chromium;
    case 'candidate-desktop-chromium': return candidate && chromium && project.metadata.deviceClass === 'desktop';
    case 'candidate-mobile-projects': return candidate && project.metadata.deviceClass === 'mobile';
    case 'candidate-mobile-chromium': return candidate && chromium && project.metadata.deviceClass === 'mobile';
  }
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
    const run = new AuditRun(page, testInfo, evidencePolicy);
    await use(run);
    await run.holdFinalVideoOutcome();
    await run.finalize();
  },
});

const release = (process.env.AUDIT_PROFILE ?? 'release') === 'release';
const interactionVideo = release
  ? {
      mode: 'on' as const,
      size: { width: 800, height: 600 },
      show: {
        actions: { duration: 700, position: 'bottom-right' as const, fontSize: 14, cursor: 'pointer' as const },
        test: { level: 'step' as const, position: 'top-left' as const, fontSize: 14 },
      },
    }
  : {
      mode: 'retain-on-failure' as const,
      size: { width: 800, height: 600 },
      show: {
        actions: { duration: 700, position: 'bottom-right' as const, fontSize: 14, cursor: 'pointer' as const },
        test: { level: 'step' as const, position: 'top-left' as const, fontSize: 14 },
      },
    };
const interactionBase = auditedBase.extend({
  video: [interactionVideo, { scope: 'worker' }],
});
export const staticTest = auditedBase.extend({
  video: ['off', { scope: 'worker' }],
});
export const structuredTest = auditedBase.extend({
  video: ['off', { scope: 'worker' }],
});

function evidenceDetails(
  mode: AuditEvidenceMode,
  rationale: string,
): { annotation: { type: string; description: string }; tag: string } {
  const policy = createEvidencePolicy(mode, rationale);
  return {
    annotation: {
      type: AUDIT_EVIDENCE_POLICY_ANNOTATION,
      description: serializeEvidencePolicy(policy),
    },
    tag: `@evidence-${mode}`,
  };
}

type InteractionEvidenceDetails = ReturnType<typeof evidenceDetails> & {
  applicability: InteractionApplicability;
};

export function interactionEvidence(
  rationale: string,
  applicability: InteractionApplicability,
): InteractionEvidenceDetails {
  return { ...evidenceDetails('interaction-video', rationale), applicability };
}

export function staticEvidence(rationale: string): ReturnType<typeof evidenceDetails> {
  return evidenceDetails('static-screenshot', rationale);
}

export function structuredEvidence(rationale: string): ReturnType<typeof evidenceDetails> {
  return evidenceDetails('structured-data', rationale);
}

type InteractionBody = Parameters<typeof interactionBase>[2];

export function interactionTest(
  title: string,
  details: InteractionEvidenceDetails,
  body: InteractionBody,
): void {
  interactionBase.describe(() => {
    interactionBase.skip(
      ({ auditProject }) => !interactionApplies(details.applicability, auditProject),
      `Interaction evidence applies to ${details.applicability.replaceAll('-', ' ')} only.`,
    );
    interactionBase(title, { annotation: details.annotation, tag: details.tag }, body);
  });
}

export const test = auditedBase;

export { expect };
