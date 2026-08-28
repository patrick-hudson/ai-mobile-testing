import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveRunnerRevision } from '../shared/runner-revision.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(repositoryRoot, '.audit-runner-revision'));
const revision = await deriveRunnerRevision(repositoryRoot, { prefix: 'image' });
await fs.writeFile(output, `${revision}\n`, { mode: 0o444 });
process.stdout.write(`${revision}\n`);
