import assert from 'node:assert/strict';
import {
  CONSOLE_ACTION_POLICIES,
  CONSOLE_ASYNC_STATES,
  CONSOLE_CONNECTION_STATES,
  CONSOLE_CONTEXT_CAPABILITIES,
  CONSOLE_CONTRACT_SCHEMA_VERSION,
  CONSOLE_CONTROLLER_OWNERSHIP,
  CONSOLE_ROUTE_CONTRACTS,
  CONSOLE_STATE_DOMAINS,
  CONSOLE_SURFACE_IDS,
  assertClientMayWriteStateDomain,
  getConsoleCapabilities,
  getConsoleRouteContract,
  parseConsoleUrlState,
  resolveConsoleActionAvailability,
  resolveConsoleRouteId,
  serializeConsoleUrlState,
  stateDomainOwner,
} from '../portal/console-contracts.mjs';
import { JOB_EXECUTION_STATES, WORKER_ACTIVITY_STATES } from './lib/job-queue.mjs';

assert.equal(CONSOLE_CONTRACT_SCHEMA_VERSION, 1);
for (const value of [
  CONSOLE_ROUTE_CONTRACTS,
  CONSOLE_CONTEXT_CAPABILITIES,
  CONSOLE_ACTION_POLICIES,
  CONSOLE_CONTROLLER_OWNERSHIP,
]) assert(Object.isFrozen(value));

const liveRoutes = Object.values(CONSOLE_ROUTE_CONTRACTS).filter(({ runtime }) => runtime === 'live');
assert.equal(new Set(liveRoutes.map(({ pathname }) => pathname)).size, liveRoutes.length, 'Live route paths must be unique.');
assert.equal(new Set(CONSOLE_SURFACE_IDS).size, CONSOLE_SURFACE_IDS.length, 'Qualified surface identities must be unique.');
assert.equal(resolveConsoleRouteId('/'), 'overview');
assert.equal(resolveConsoleRouteId('/report.html'), 'report');
assert.equal(resolveConsoleRouteId('/gallery.html'), 'gallery');
assert.equal(resolveConsoleRouteId('index.html', { runtime: 'sealed-archive' }), 'archive-report');
assert.equal(resolveConsoleRouteId('/tmp/export/gallery.html', { runtime: 'sealed-archive' }), 'archive-gallery');
assert.equal(resolveConsoleRouteId('/missing.html'), null);
assert.equal(getConsoleRouteContract('overview').group, 'operations');
assert.equal(getConsoleRouteContract('new-audit').group, 'creation');
assert.equal(getConsoleRouteContract('settings').group, 'configuration');
assert.equal(getConsoleRouteContract('archive-gallery').runtime, 'sealed-archive');

const comparative = getConsoleCapabilities('comparative-live');
assert.deepEqual(comparative.transport, { kind: 'sse', resume: 'sequence', fallback: 'bounded-snapshot' });
assert.equal(comparative.auditMode, 'comparative');
assert.equal(comparative.actions.stop, true);
assert.equal(comparative.actions.cancel, false);
assert.equal(comparative.actions.manualEvidence, true);
assert.equal(comparative.actions.visualDisposition, true);
assert.equal(comparative.actions.rekick, true);
assert.equal(comparative.actions.riskAcknowledge, true);
assert.equal(comparative.actions.riskResolve, true);
assert.equal(comparative.archiveMutability, 'not-applicable');

const singleSite = getConsoleCapabilities('single-site-live');
assert.deepEqual(singleSite.transport, { kind: 'polling', resume: 'revision', fallback: 'bounded-snapshot' });
assert.equal(singleSite.auditMode, 'single-site');
assert.equal(singleSite.actions.stop, false);
assert.equal(singleSite.actions.cancel, true);
assert.equal(singleSite.actions.manualEvidence, false);
assert.equal(singleSite.actions.visualDisposition, true);
assert.equal(singleSite.actions.baseline, true);
assert.equal(singleSite.actions.rekick, true);
assert.equal(singleSite.actions.riskAcknowledge, true);
assert.equal(singleSite.actions.riskResolve, true);

const archive = getConsoleCapabilities('sealed-archive');
assert.deepEqual(archive.transport, { kind: 'sealed', resume: 'none', fallback: 'none' });
assert.equal(archive.auditMode, 'source-defined', 'Archive runtime must preserve, not replace, the source audit mode.');
assert.equal(Object.values(archive.actions).some(Boolean), false, 'Sealed archives must expose no live action.');
assert.equal(archive.archiveMutability, 'read-only');
assert.equal(archive.destinations.report, true);
assert.equal(archive.destinations.gallery, true);
assert.equal(archive.destinations.sourceReport, false);

const unsupportedCancel = resolveConsoleActionAvailability('comparative-live', 'cancel');
assert.deepEqual({
  supported: unsupportedCancel.supported,
  authorized: unsupportedCancel.authorized,
  eligible: unsupportedCancel.eligible,
  available: unsupportedCancel.available,
}, { supported: false, authorized: null, eligible: null, available: false });
assert.match(unsupportedCancel.unavailableReason, /stop contract/i);
const pendingStop = resolveConsoleActionAvailability('comparative-live', 'stop');
assert.equal(pendingStop.supported, true);
assert.equal(pendingStop.available, false);
assert.match(pendingStop.unavailableReason, /authorization has not been established/i);
const eligibleStop = resolveConsoleActionAvailability('comparative-live', 'stop', { authorized: true, eligible: true });
assert.equal(eligibleStop.available, true);
assert.equal(eligibleStop.unavailableReason, null);
const ineligibleBaseline = resolveConsoleActionAvailability('single-site-live', 'baseline', { authorized: true, eligible: false });
assert.equal(ineligibleBaseline.available, false);
assert.match(ineligibleBaseline.unavailableReason, /authoritative run state/i);
for (const contextId of ['comparative-live', 'single-site-live']) {
  const rekick = resolveConsoleActionAvailability(contextId, 'rekick', { authorized: true, eligible: false });
  assert.equal(rekick.supported, true);
  assert.match(rekick.unavailableReason, /incomplete/i);
  assert.equal(resolveConsoleActionAvailability(contextId, 'visualDisposition', { authorized: true, eligible: true }).available, true);
}

assert.equal(stateDomainOwner('execution'), 'audit-authority');
assert.equal(stateDomainOwner('activity'), 'audit-authority');
assert.equal(stateDomainOwner('connection'), 'browser-transport');
assert.equal(stateDomainOwner('region'), 'browser-region');
assert.throws(() => assertClientMayWriteStateDomain('execution'), /must not write execution state/i);
assert.throws(() => assertClientMayWriteStateDomain('activity'), /must not write activity state/i);
assert.equal(assertClientMayWriteStateDomain('connection'), true);
assert.equal(assertClientMayWriteStateDomain('region'), true);
assert.deepEqual(CONSOLE_STATE_DOMAINS.connection.values, CONSOLE_CONNECTION_STATES);
assert.deepEqual(CONSOLE_STATE_DOMAINS.region.values, CONSOLE_ASYNC_STATES);
for (const durable of [JOB_EXECUTION_STATES, WORKER_ACTIVITY_STATES]) {
  assert.equal(durable.some((value) => CONSOLE_CONNECTION_STATES.includes(value)), false);
  assert.equal(durable.some((value) => CONSOLE_ASYNC_STATES.includes(value)), false);
}
for (const required of ['ready', 'partial', 'stale', 'unavailable', 'reconnecting', 'offline']) {
  assert(CONSOLE_ASYNC_STATES.includes(required), `Async vocabulary must include ${required}.`);
}
const stateSeparationFixtures = [
  {
    name: 'comparative reconnect retains authority', contextId: 'comparative-live', execution: 'running', activity: 'normal',
    connection: 'reconnecting', region: 'stale', retainedAuthority: true,
  },
  {
    name: 'Single-site partial polling retains authority', contextId: 'single-site-live', execution: 'finalizing', activity: 'recovering',
    connection: 'offline', region: 'partial', retainedAuthority: true,
  },
  {
    name: 'sealed archive is ready without a live connection', contextId: 'sealed-archive', execution: 'completed', activity: 'normal',
    connection: null, region: 'ready', retainedAuthority: true,
  },
];
for (const fixture of stateSeparationFixtures) {
  assert(CONSOLE_ASYNC_STATES.includes(fixture.region), fixture.name);
  assert(JOB_EXECUTION_STATES.includes(fixture.execution), fixture.name);
  assert(WORKER_ACTIVITY_STATES.includes(fixture.activity), fixture.name);
  if (fixture.connection !== null) assert(CONSOLE_CONNECTION_STATES.includes(fixture.connection), fixture.name);
  assert.equal(fixture.retainedAuthority, true, fixture.name);
  assert.equal(fixture.connection === fixture.execution || fixture.region === fixture.execution, false, fixture.name);
  assert(getConsoleCapabilities(fixture.contextId));
}

const report = parseConsoleUrlState('report', 'mode=single-site&run=job-123');
assert.equal(report.valid, true);
assert.deepEqual(report.state, { mode: 'single-site', run: 'job-123' });
assert.equal(report.search, 'mode=single-site&run=job-123');

const runWorkspace = parseConsoleUrlState('run', 'view=logs&mode=comparative&run=run-123&search=HTTP%20200&source=stdout&stage=browser&shard=1');
assert.equal(runWorkspace.valid, true);
assert.equal(runWorkspace.search, 'inspector=closed&mode=comparative&run=run-123&search=HTTP+200&shard=1&source=stdout&stage=browser&view=logs');

const gallery = parseConsoleUrlState('gallery', new URL(
  'http://127.0.0.1:4173/gallery.html?run=run-123&from=report&kind=video&kind=image&review=all&item=gitem_0123456789abcdef&member=gmember_0123456789abcdef',
));
assert.equal(gallery.valid, true);
assert.deepEqual(gallery.state.kind, ['video', 'image']);
assert.equal(gallery.state.run, 'run-123');
assert.equal(gallery.state.from, 'report');
assert.equal(gallery.state.review, 'all');
assert.equal(gallery.rejected.length, 0);
assert.equal(gallery.search, 'coverage=all&finding=all&from=report&group=feature&item=gitem_0123456789abcdef&kind=image&kind=video&member=gmember_0123456789abcdef&mode=comparative&raw=0&review=all&run=run-123&sort=attention&view=workbench&visual=all');

const singleSiteOverview = parseConsoleUrlState(
  'gallery',
  'mode=single-site&run=run-123&view=overview&coverage=gap&visual=CHANGED&from=report',
);
assert.equal(singleSiteOverview.valid, true);
assert.deepEqual(singleSiteOverview.state, {
  mode: 'single-site',
  run: 'run-123',
  view: 'overview',
  coverage: 'gap',
  visual: 'CHANGED',
  from: 'report',
  review: 'attention',
  finding: 'all',
  group: 'feature',
  sort: 'attention',
  raw: '0',
});

const legacyOverview = parseConsoleUrlState('gallery', 'mode=overview&run=run-123&view=overview');
assert.equal(legacyOverview.valid, true);
assert.equal(legacyOverview.state.mode, 'overview');
assert.equal(legacyOverview.state.view, 'overview');

const sealed = parseConsoleUrlState('archive-gallery', new URL(
  'file:///tmp/audit-export/checklist/gallery.html?mode=overview&kind=image&status=failed&featureSuite=navigation&visual=CHANGED&item=gitem_0123456789abcdef&raw=1',
));
assert.equal(sealed.valid, true);
assert.equal(sealed.state.mode, 'overview');
assert.deepEqual(sealed.state.kind, ['image']);
assert.deepEqual(sealed.state.status, ['failed']);
assert.deepEqual(sealed.state.featureSuite, ['navigation']);
assert.equal(sealed.state.item, 'gitem_0123456789abcdef');
assert.equal(sealed.state.raw, '1');
assert(sealed.rejected.some(({ code, key }) => code === 'unknown-key' && key === 'visual'));

const cursor = parseConsoleUrlState('gallery', 'run=run-123&cursor=opaque-secret-cursor');
assert.equal(cursor.valid, true);
assert(cursor.rejected.some(({ code, key }) => code === 'cursor-not-url-state' && key === 'cursor'));
assert.equal('cursor' in cursor.state, false);

const duplicateIdentity = parseConsoleUrlState('report', 'run=first-run&run=second-run');
assert.equal(duplicateIdentity.valid, false);
assert(duplicateIdentity.rejected.some(({ code, key }) => code === 'duplicate-key' && key === 'run'));
assert(duplicateIdentity.errors.some(({ code, key }) => code === 'required-key-missing' && key === 'run'));

const duplicateFilter = parseConsoleUrlState('gallery', 'run=run-123&kind=image&kind=image');
assert(duplicateFilter.rejected.some(({ code, key }) => code === 'duplicate-value' && key === 'kind'));

for (const [unsafe, expectedCode] of [
  ['run=run-123&api_key=plain-text-value', 'unsafe-key'],
  ['run=sk-ant-secret-like-value', 'secret-like-value'],
  ['run=run-123&q=authorization%3A%20Bearer%20secret-token-value', 'secret-like-value'],
  ['run=run-123&q=authorization%253A%2520Bearer%2520secret-token-value', 'invalid-value'],
  ['run=run-123&__proto__=polluted', 'unsafe-key'],
  ['run=run-123&unknown=value', 'unknown-key'],
  ['run=run-123&exportRevision=export_0123456789abcdef', 'unknown-key'],
  ['run=run-123&mode=invalid-mode', 'invalid-value'],
]) {
  const parsed = parseConsoleUrlState('gallery', unsafe);
  assert(parsed.rejected.some(({ code }) => code === expectedCode), `Expected ${expectedCode} for ${unsafe}`);
  assert(!parsed.search.includes('secret-token-value'));
}

const overlongField = parseConsoleUrlState('gallery', `run=run-123&q=${'a'.repeat(1_201)}`);
assert(overlongField.rejected.some(({ code, key }) => code === 'invalid-value' && key === 'q'));
const oversized = parseConsoleUrlState('gallery', `run=run-123&q=${'a'.repeat(4_200)}`);
assert.equal(oversized.valid, false);
assert(oversized.rejected.some(({ code }) => code === 'query-too-large'));

const wrongRoute = parseConsoleUrlState('report', new URL('http://127.0.0.1:4173/gallery.html?run=run-123'));
assert.equal(wrongRoute.valid, false);
assert(wrongRoute.errors.some(({ code }) => code === 'route-mismatch'));

assert.equal(serializeConsoleUrlState('run', {
  run: 'job-123',
  mode: 'single-site',
  view: 'logs',
  inspector: 'closed',
}), 'inspector=closed&mode=single-site&run=job-123&view=logs');
assert.throws(() => serializeConsoleUrlState('run', {
  run: 'job-123',
  mode: 'single-site',
  cursor: 'not-safe-state',
}), /invalid/i);

const ownershipKeys = new Set();
for (const [identity, entry] of Object.entries(CONSOLE_CONTROLLER_OWNERSHIP)) {
  const key = `${entry.surface}\u0000${entry.concern}`;
  assert(!ownershipKeys.has(key), `Duplicate controller owner for ${entry.surface}/${entry.concern} (${identity}).`);
  ownershipKeys.add(key);
}
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['new-audit.launch-mutation'].owner, 'portal/public/new-audit.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['settings.credential-mutations'].owner, 'portal/public/settings.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['landing.launch-mutation'], undefined);
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['landing.credential-mutations'], undefined);
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['overview.run-list-polling'].owner, 'portal/public/overview.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['runs.run-history'].owner, 'portal/public/runs.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['comparative.run-workspace'].owner, 'portal/public/run-workspace.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['single-site.run-workspace'].owner, 'portal/public/run-workspace.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['live.gallery-reducer'].handoffUnit, 'retained');
assert.match(CONSOLE_CONTROLLER_OWNERSHIP['archive.gallery-reducer'].owner, /gallery-core\.js/);

assert.throws(() => {
  CONSOLE_CONTEXT_CAPABILITIES['comparative-live'].actions.stop = false;
}, TypeError);

console.log('Portal console contracts self-test passed.');
