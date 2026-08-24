#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GALLERY_SCHEMA_VERSION,
  assertGalleryCatalog,
  stableGalleryKey,
} from '../shared/gallery-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function contained(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function validateRequest(value) {
  if (value?.schemaVersion !== GALLERY_SCHEMA_VERSION || value.operation !== 'publish-live-attempt') {
    throw new Error('Invalid live gallery publication request.');
  }
  const galleryRoot = path.resolve(value.galleryRoot);
  if (path.basename(galleryRoot) !== 'gallery-live') throw new Error('Live gallery root is invalid.');
  return {
    galleryRoot,
    sourceShard: value.sourceShard ?? null,
    incoming: assertGalleryCatalog(value.incoming),
  };
}

function mergeCatalogs(current, incoming) {
  const items = new Map(current?.items.map((item) => [item.id, item]) ?? []);
  const blobs = new Map(current?.blobs.map((blob) => [blob.id, blob]) ?? []);
  for (const item of incoming.items) items.set(item.id, item);
  for (const blob of incoming.blobs) {
    const prior = blobs.get(blob.id);
    blobs.set(blob.id, prior ? {
      ...blob,
      storageLocations: [...new Set([...prior.storageLocations, ...blob.storageLocations])].sort(),
    } : blob);
  }
  const orderedItems = [...items.values()].sort((left, right) => left.id.localeCompare(right.id));
  return assertGalleryCatalog({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items: orderedItems,
    blobs: [...blobs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    primaryCounts: { total: orderedItems.length, images: orderedItems.length, videos: 0 },
  });
}

async function currentCatalog(root) {
  const head = await readOptionalJson(path.join(root, 'current.json'));
  if (!head) return null;
  if (head.schemaVersion !== GALLERY_SCHEMA_VERSION || head.phase !== 'live' || typeof head.revisionHref !== 'string') {
    throw new Error('The current live gallery head is invalid.');
  }
  const revisionFile = path.resolve(root, head.revisionHref);
  if (!contained(root, revisionFile)) throw new Error('The current live gallery revision escapes its root.');
  const revision = await readJson(revisionFile);
  if (revision.contentRevision !== head.contentRevision) throw new Error('The live gallery head and revision disagree.');
  return assertGalleryCatalog(revision.catalog);
}

function facets(catalog) {
  const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))].sort();
  return {
    kinds: unique(catalog.items.map(({ kind }) => kind)),
    statuses: unique(catalog.items.map(({ attempt }) => attempt.status)),
    environments: unique(catalog.items.map(({ project }) => project.environment)),
    featureSuites: unique(catalog.items.flatMap(({ auditAssociations }) => auditAssociations.map(({ featureSuite }) => featureSuite))),
    technicalSuites: unique(catalog.items.map(({ test }) => test.technicalSuite)),
    targets: unique(catalog.items.flatMap(({ project }) => [project.name, project.browser, project.deviceClass])),
    flagStates: ['unflagged'],
  };
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o640 });
  await fs.rename(temporary, file);
}

async function commit(requestValue) {
  const request = validateRequest(requestValue);
  await fs.mkdir(path.join(request.galleryRoot, 'revisions'), { recursive: true });
  const catalog = mergeCatalogs(await currentCatalog(request.galleryRoot), request.incoming);
  const contentRevision = `content_${stableGalleryKey({
    items: catalog.items,
    blobs: catalog.blobs.map(({ id, sha256, sizeBytes, contentType, kind, href }) => ({ id, sha256, sizeBytes, contentType, kind, href })),
  })}`;
  const flagRevision = `flags_${stableGalleryKey([])}`;
  const orderRevision = `order_${stableGalleryKey({ contentRevision, flagRevision, schemaVersion: 1 })}`;
  const producedAt = new Date().toISOString();
  const revisionHref = `revisions/${contentRevision}.json`;
  const revision = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    phase: 'live',
    contentRevision,
    producedAt,
    sourceShard: request.sourceShard,
    catalog,
  };
  try {
    await fs.writeFile(path.join(request.galleryRoot, revisionHref), `${JSON.stringify(revision)}\n`, {
      encoding: 'utf8', mode: 0o640, flag: 'wx',
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const head = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    phase: 'live',
    contentRevision,
    flagRevision,
    orderRevision,
    producedAt,
    primaryCounts: catalog.primaryCounts,
    facets: facets(catalog),
    sourceShard: request.sourceShard,
    revisionHref,
  };
  await atomicWrite(path.join(request.galleryRoot, 'current.json'), head);
  process.stdout.write(`${JSON.stringify(head)}\n`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function portableLock(root) {
  const lock = path.join(root, '.publish.portable-lock');
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      return async () => fs.rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readOptionalJson(path.join(lock, 'owner.json')).catch(() => null);
      if (Number.isInteger(owner?.pid) && !processExists(owner.pid)) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function withLinuxFlock(requestPath, root) {
  const child = spawn('flock', ['--exclusive', path.join(root, '.publish.lock'), process.execPath, scriptPath, '--locked', requestPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => signal ? reject(new Error(`flock helper exited via ${signal}.`)) : resolveExit(status ?? 1));
  });
  if (code !== 0) throw new Error(`flock helper exited with status ${code}.`);
}

async function main() {
  const [mode, requestValue] = process.argv.slice(2);
  if (!['--request', '--locked'].includes(mode) || !requestValue) throw new Error('Usage: live-gallery-publish.mjs --request <request.json>');
  const requestPath = path.resolve(requestValue);
  const request = validateRequest(await readJson(requestPath));
  try {
    if (mode === '--locked') await commit(await readJson(requestPath));
    else if (process.platform === 'linux') await withLinuxFlock(requestPath, request.galleryRoot);
    else {
      const release = await portableLock(request.galleryRoot);
      try { await commit(await readJson(requestPath)); } finally { await release(); }
    }
  } finally {
    await fs.rm(requestPath, { force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
