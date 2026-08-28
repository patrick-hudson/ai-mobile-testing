import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSingleSiteReportDocuments } from './site-health-report.mjs';

const MAX_DOCUMENT_BYTES = 512 * 1024;

function identicalBytes(left, right) {
  return Buffer.byteLength(left) === Buffer.byteLength(right)
    && createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex');
}

async function writeDurableFile(file, source, flag = 'wx') {
  const handle = await open(file, flag, 0o600);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyExistingRevision(revisionDir, documents, publicationSource) {
  const expected = new Map(documents);
  expected.set('publication.json', publicationSource);
  for (const [relativePath, source] of expected) {
    let existing;
    try {
      existing = await readFile(path.join(revisionDir, ...relativePath.split('/')));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Single-site report revision ${path.basename(revisionDir)} is incomplete: ${relativePath} is missing.`);
      }
      throw error;
    }
    if (!identicalBytes(existing, source)) {
      throw new Error(`Single-site report revision ${path.basename(revisionDir)} conflicts with immutable file ${relativePath}.`);
    }
  }
}

export async function writeSingleSiteReportPublication({ outputDir, input, publicationRevision = undefined }) {
  const resolvedOutput = path.resolve(outputDir);
  const dataDir = path.join(resolvedOutput, 'data');
  const revision = publicationRevision ?? randomUUID().replaceAll('-', '');
  const { summary, documents: rawDocuments } = buildSingleSiteReportDocuments(input, {
    publicationRevision: revision,
  });
  const documents = new Map();
  for (const [relativePath, document] of rawDocuments) {
    const source = `${JSON.stringify(document)}\n`;
    const bytes = Buffer.byteLength(source);
    if (bytes < 1 || bytes > MAX_DOCUMENT_BYTES) {
      throw new Error(`Single-site compact report document ${relativePath} exceeds its ${MAX_DOCUMENT_BYTES}-byte bound.`);
    }
    documents.set(relativePath, source);
  }
  const publication = {
    schemaVersion: 1,
    kind: 'single-site-report-publication',
    mode: 'single-site',
    publicationRevision: revision,
    generatedAt: summary.generatedAt,
    files: Object.fromEntries([...documents].map(([relativePath, source]) => [relativePath, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  };
  const publicationSource = `${JSON.stringify(publication)}\n`;
  const revisionsDir = path.join(dataDir, 'revisions');
  const revisionDir = path.join(revisionsDir, revision);
  const temporaryRevisionDir = path.join(
    revisionsDir,
    `.${revision}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  await mkdir(revisionsDir, { recursive: true });
  try {
    await mkdir(temporaryRevisionDir, { mode: 0o700 });
    await Promise.all([...documents].map(async ([relativePath, source]) => {
      const destination = path.join(temporaryRevisionDir, ...relativePath.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeDurableFile(destination, source);
    }));
    await writeDurableFile(path.join(temporaryRevisionDir, 'publication.json'), publicationSource);
    const revisionDirectories = new Set([temporaryRevisionDir]);
    for (const relativePath of documents.keys()) {
      let directory = path.dirname(path.join(temporaryRevisionDir, ...relativePath.split('/')));
      while (directory.startsWith(`${temporaryRevisionDir}${path.sep}`)) {
        revisionDirectories.add(directory);
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...revisionDirectories].sort((left, right) => right.length - left.length)) {
      await fsyncDirectory(directory);
    }
    try {
      await rename(temporaryRevisionDir, revisionDir);
      await fsyncDirectory(revisionsDir);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await verifyExistingRevision(revisionDir, documents, publicationSource);
    }
  } finally {
    await rm(temporaryRevisionDir, { recursive: true, force: true });
  }

  await Promise.all([...documents].map(async ([relativePath, source]) => {
    const destination = path.join(dataDir, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, { encoding: 'utf8', mode: 0o600 });
  }));
  const temporaryPointer = path.join(dataDir, `.current-${revision}.tmp`);
  const randomizedTemporaryPointer = `${temporaryPointer}.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    await writeDurableFile(randomizedTemporaryPointer, publicationSource);
    await rename(randomizedTemporaryPointer, path.join(dataDir, 'current.json'));
    await fsyncDirectory(dataDir);
  } finally {
    await rm(randomizedTemporaryPointer, { force: true });
  }
  return summary;
}
