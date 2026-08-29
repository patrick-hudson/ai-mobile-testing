#!/usr/bin/env node
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { buildProductionDerivedShadowMatrix } from './lib/shadow-validation-adapters.mjs';
import { runShadowValidation } from '../shared/shadow-validation.mjs';

function outputArgument(argv) {
  if (argv.length === 0) return 'shadow-validation.json';
  if (argv.length !== 2 || argv[0] !== '--output' || argv[1].startsWith('-')) {
    throw new TypeError('Usage: run-shadow-validation.mjs [--output <path-under-artifacts/shadow-validation>]');
  }
  return argv[1];
}

async function validatedOutputPath(argument) {
  const root = resolve(process.cwd(), 'artifacts/shadow-validation');
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const output = resolve(canonicalRoot, argument);
  const pathFromRoot = relative(canonicalRoot, output);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new TypeError('Shadow output must be a file under artifacts/shadow-validation.');
  }
  await mkdir(dirname(output), { recursive: true });
  const canonicalParent = await realpath(dirname(output));
  const parentFromRoot = relative(canonicalRoot, canonicalParent);
  if (parentFromRoot === '..' || parentFromRoot.startsWith(`..${sep}`)) {
    throw new TypeError('Shadow output must not traverse a symlink outside artifacts/shadow-validation.');
  }
  return output;
}

try {
  const output = await validatedOutputPath(outputArgument(process.argv.slice(2)));
  const report = runShadowValidation({
    ...await buildProductionDerivedShadowMatrix(),
    generatedAt: new Date().toISOString(),
  });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640, flag: 'wx' });
  await rename(temporary, output);
  process.stdout.write(`[shadow-validation] diagnostic-only ${report.validationStatus} · ${report.summary.cases} cases · ${report.summary.reviewedDifferences} reviewed differences · ${report.summary.unexplainedDrift} unexplained drift\n`);
  process.exitCode = report.validationStatus === 'PASS' ? 0 : 2;
} catch (error) {
  process.stderr.write(`[shadow-validation] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
