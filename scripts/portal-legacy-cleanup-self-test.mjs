import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CONSOLE_CONTROLLER_OWNERSHIP,
  resolveConsoleRouteId,
} from '../portal/console-contracts.mjs';

const repositoryRoot = process.cwd();
const publicRoot = join(repositoryRoot, 'portal', 'public');

async function readPublicAsset(name) {
  return readFile(join(publicRoot, name), 'utf8');
}

const rootDocument = await readPublicAsset('index.html');
assert.match(rootDocument, /<script src="\/overview\.js" type="module"><\/script>/);
assert.doesNotMatch(rootDocument, /(?:src|href)="\/(?:app\.js|styles\.css)"/);
assert.doesNotMatch(rootDocument, /id="(?:launch-form|runs-panel|run-list|run-dialog)"/);
for (const documentName of (await readdir(publicRoot)).filter((name) => name.endsWith('.html'))) {
  assert.doesNotMatch(await readPublicAsset(documentName), /(?:src|href)="\/app\.js"/, `${documentName} loads the legacy controller.`);
}

for (const removedAsset of ['app.js', 'overview.html']) {
  await assert.rejects(
    access(join(publicRoot, removedAsset)),
    (error) => error?.code === 'ENOENT',
    `Dead public asset remains servable: ${removedAsset}`,
  );
}

const styles = await readPublicAsset('styles.css');
for (const obsoleteSelector of [
  '.choice-grid',
  '.launch-footer',
  '.key-settings',
  '.system-status',
  '.masthead',
  '.run-list',
  '.run-card',
  '.purge-confirmation',
  '.stage-section',
  '.manual-evidence-section',
  '.evidence-layout',
]) {
  assert(!styles.includes(obsoleteSelector), `Obsolete selector remains in styles.css: ${obsoleteSelector}`);
}
for (const retainedSelector of [
  '.primary-button',
  '.run-dialog',
  '.dialog-header',
  '.live-log',
  '.artifact-link',
]) {
  assert(styles.includes(retainedSelector), `Shared report/gallery selector was removed: ${retainedSelector}`);
}

for (const [identity, entry] of Object.entries(CONSOLE_CONTROLLER_OWNERSHIP)) {
  assert.notEqual(entry.owner, 'portal/public/app.js', `${identity} still names the deleted legacy controller.`);
}
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['overview.run-list-polling'].owner, 'portal/public/overview.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['runs.run-history'].owner, 'portal/public/runs.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['comparative.run-workspace'].owner, 'portal/public/run-workspace.js');
assert.equal(CONSOLE_CONTROLLER_OWNERSHIP['single-site.run-workspace'].owner, 'portal/public/run-workspace.js');

assert.equal(resolveConsoleRouteId('/'), 'overview');
// `/` is the sole Overview entry; the uncontracted duplicate static page is gone.
assert.equal(resolveConsoleRouteId('/overview.html'), null);
assert.equal(resolveConsoleRouteId('/runs.html'), 'runs');
assert.equal(resolveConsoleRouteId('/run.html'), 'run');
assert.equal(resolveConsoleRouteId('/new-audit.html'), 'new-audit');
assert.equal(resolveConsoleRouteId('/settings.html'), 'settings');

for (const replacementAsset of [
  'overview.js',
  'runs.js',
  'run-workspace.js',
  'new-audit.js',
  'settings.js',
]) {
  await access(join(publicRoot, replacementAsset));
}

const shellSource = await readPublicAsset('console-shell.js');
assert.match(shellSource, /export const CONSOLE_NAVIGATION_ITEMS/);
for (const controller of ['console-index-page.js', 'run-workspace.js', 'new-audit.js', 'settings.js']) {
  const source = await readPublicAsset(controller);
  assert.match(source, /CONSOLE_NAVIGATION_ITEMS/, `${controller} does not use the shared primary navigation model.`);
  assert.doesNotMatch(source, /navigationItems:\s*\[/, `${controller} embeds a divergent primary navigation model.`);
}

const server = await readFile(join(repositoryRoot, 'portal', 'server.mjs'), 'utf8');
assert.match(server, /pathname === '\/' \? 'index\.html'/);
assert.doesNotMatch(server, /['"]\/app\.js['"]/);
assert.match(server, /\^\\\/artifacts\\\/\(\[\^\/\]\+\)/);
assert.match(server, /\^\\\/single-site-artifacts\\\/\(\[\^\/\]\+\)/);
for (const retainedFallback of [
  'checklist/index.html',
  'playwright-html/index.html',
  "join(checklistRoot, 'gallery.html')",
]) {
  assert(server.includes(retainedFallback), `Required fallback disappeared from portal/server.mjs: ${retainedFallback}`);
}

console.log('Portal legacy cleanup self-test passed.');
