import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const init = await readFile(new URL('../docker/init-single-site-volumes.sh', import.meta.url), 'utf8');
const fenceSource = await readFile(new URL('./lib/legacy-authority-fence.mjs', import.meta.url), 'utf8');
const releaseSource = await readFile(new URL('./run-legacy-comparative-release.mjs', import.meta.url), 'utf8');
const packageDocument = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const canonicalRoot = '/var/lib/ai-mobile-testing/shared/canonical';
const fenceRoot = `${canonicalRoot}/legacy-authority`;

function serviceBlock(name) {
  return compose.match(new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  [a-z][a-z0-9-]+:|\\nvolumes:)`, 'u'))?.[0] ?? '';
}

for (const name of ['portal', 'single-site-finalizer', 'audit-release', 'audit-release-merge']) {
  const block = serviceBlock(name);
  assert.ok(block, `${name} service must exist`);
  assert.match(block, new RegExp(`AUDIT_LEGACY_AUTHORITY_FENCE_ROOT: ${fenceRoot}`, 'u'),
    `${name} must use the canonical legacy fence`);
  assert.match(block, new RegExp(`shared-parent-runs:${canonicalRoot}`, 'u'),
    `${name} must mount the same canonical volume as the fence root`);
}

assert.match(init, /init-legacy-authority-fence\.mjs \/var\/lib\/ai-mobile-testing\/shared\/canonical\/legacy-authority/u);
assert.match(init, /chown -R pwuser:pwuser \/var\/lib\/ai-mobile-testing\/shared\/canonical\/legacy-authority/u);
assert.match(fenceSource, /AUDIT_LEGACY_AUTHORITY_FENCE_ROOT is required for every legacy authority-bearing process/u,
  'missing fence configuration must fail closed');
assert.doesNotMatch(fenceSource, /if \(typeof root !== 'string' \|\| !root\) return null/u);
assert.equal(packageDocument.scripts['audit:release:container'], 'node scripts/run-legacy-comparative-release.mjs');
assert.match(releaseSource, /withAuthority\('comparative-launch', runPlaywright\)/u,
  'the direct Comparative release must hold the fence through completion');
assert.match(releaseSource, /shell: false/u, 'the release wrapper must not invoke a shell');

process.stdout.write('Legacy authority Compose contract self-test passed.\n');
