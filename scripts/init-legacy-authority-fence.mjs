#!/usr/bin/env node

import path from 'node:path';

import { initializeLegacyAuthorityFence } from './lib/legacy-authority-fence.mjs';

const [root] = process.argv.slice(2);
if (typeof root !== 'string' || !path.isAbsolute(root)) {
  process.stderr.write('Usage: node scripts/init-legacy-authority-fence.mjs <absolute-root>\n');
  process.exitCode = 2;
} else {
  const fence = await initializeLegacyAuthorityFence({ root });
  const document = await fence.read();
  process.stdout.write(`${JSON.stringify({
    event: 'legacy-authority-fence-ready',
    state: document.state,
    revision: document.revision,
    activationEpoch: document.activationEpoch,
    digest: document.digest,
  })}\n`);
}
