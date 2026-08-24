import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  auditTargetRegistryDocument,
  validateAuditTargetCatalog,
} from '../audit/targets.js';

const allowedArguments = new Set(['--check']);
const unknownArguments = process.argv.slice(2).filter((argument) => !allowedArguments.has(argument));
if (unknownArguments.length > 0) throw new Error(`Unknown target validation arguments: ${unknownArguments.join(', ')}.`);

validateAuditTargetCatalog();
const destinationUrl = new URL('../audit/targets.generated.json', import.meta.url);
const destinationPath = fileURLToPath(destinationUrl);
const expected = `${JSON.stringify(auditTargetRegistryDocument(), null, 2)}\n`;
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  let current: string;
  try {
    current = readFileSync(destinationUrl, 'utf8');
  } catch (error) {
    throw new Error(`Generated target registry is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (current !== expected) {
    throw new Error('audit/targets.generated.json is stale. Run npm run targets:validate and include the generated file.');
  }
  console.log('Generated target registry is current.');
} else {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, expected, { encoding: 'utf8', mode: 0o644 });
  renameSync(temporaryPath, destinationPath);
  console.log(`Generated ${destinationPath}.`);
}
