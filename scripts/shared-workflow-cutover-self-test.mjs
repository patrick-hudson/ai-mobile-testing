import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const release = await readFile(new URL('../.github/workflows/release-audit.yml', import.meta.url), 'utf8');
const promotion = await readFile(new URL('../.github/workflows/exact-promotion.yml', import.meta.url), 'utf8');

assert.match(release, /matrix:\s*\n\s+mode: \[single-site, comparative\]/u,
  'release CI must exercise both authority modes');
assert.match(release, /node scripts\/run-shared-release-ci\.mjs/u);
assert.match(release, /--server "\$CONTROL_SERVER"/u,
  'workflow input must cross the shell boundary through a quoted environment value');
assert.match(release, /--request-id "\$REQUEST_ID"/u);
assert.match(release, /Remove credentials before evidence upload[\s\S]*Upload shared-authority receipt/u);
assert.doesNotMatch(release, /run-sharded-release|assert-release-decision|checklist\/manifest\.json/u,
  'release CI must not fall back to legacy checklist truth');
assert.doesNotMatch(release, /--server ['"]?\$\{\{/u,
  'untrusted workflow inputs must not be interpolated directly into shell commands');

assert.match(promotion, /on:\s*\n\s+workflow_call:/u);
assert.match(promotion, /artifact-ids: \$\{\{ inputs\.artifact_id \}\}/u,
  'promotion must download the immutable caller artifact by ID');
assert.match(promotion, /merge-multiple: true/u,
  'the downloaded artifact contents must land at the exact verified bundle root');
assert.match(promotion, /node scripts\/run-exact-promotion\.mjs/u);
assert.match(promotion, /--delivery-token-file \/work\/artifacts\/promotion-private\/delivery\.token/u);
assert.match(promotion, /--cloudflare-token-file \/work\/artifacts\/promotion-private\/cloudflare\.token/u);
assert.match(promotion, /--artifact-root \/work\/artifacts\/promotion-bundle\/site/u);
assert.match(promotion, /Remove delivery credentials[\s\S]*Upload non-secret promotion receipt/u);
assert.doesNotMatch(promotion, /--(?:token|cloudflare-token)\s/u,
  'credentials must never enter command arguments');
assert.doesNotMatch(promotion, /run-sharded-release|assert-release-decision/u);
assert.doesNotMatch(promotion, /--(?:server|project-id|production-account-id|production-project|production-branch|source-revision) ['"]?\$\{\{/u,
  'workflow inputs must not be interpolated directly into the delivery shell command');

process.stdout.write('Shared workflow cutover self-test passed: both audit modes use live shared authority and exact promotion consumes one immutable caller artifact without legacy fallback.\n');
