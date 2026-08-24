import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GALLERY_FLAG_HISTORY_MAX_BYTES,
  assertGalleryFlagHistory,
  emptyGalleryFlagHistory,
  galleryFlagSnapshot,
} from '../shared/gallery-contract.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const publisher = path.join(scriptDirectory, 'gallery-publish.mjs');

function contained(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

export async function readGalleryFlagHistory(runDirectory) {
  const root = path.resolve(runDirectory);
  const file = path.join(root, 'visual-flags.json');
  if (!contained(root, file)) throw new Error('Reviewer flag history escaped its run directory.');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyGalleryFlagHistory();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GALLERY_FLAG_HISTORY_MAX_BYTES) {
    const error = new Error('Reviewer flag history exceeds its bounded read limit.');
    error.statusCode = 413;
    error.code = 'GALLERY_FLAG_HISTORY_TOO_LARGE';
    throw error;
  }
  return assertGalleryFlagHistory(JSON.parse(await fs.readFile(file, 'utf8')));
}

export async function readGalleryFlagSnapshot(runDirectory) {
  return galleryFlagSnapshot(await readGalleryFlagHistory(runDirectory));
}

export async function mutateGalleryFlag(runDirectory, transition) {
  const root = path.resolve(runDirectory);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Reviewer flag run directory is not a real directory.');
  const realRoot = await fs.realpath(root);
  const galleryRoot = path.join(root, 'checklist', 'gallery');
  await fs.mkdir(galleryRoot, { recursive: true });
  const galleryStat = await fs.lstat(galleryRoot);
  const realGalleryRoot = await fs.realpath(galleryRoot);
  if (!galleryStat.isDirectory() || galleryStat.isSymbolicLink() || !contained(realRoot, realGalleryRoot)) {
    throw new Error('Reviewer flag publication directory escaped its run directory.');
  }
  const nonce = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const requestPath = path.join(galleryRoot, `.flag-request-${nonce}.json`);
  const responsePath = path.join(galleryRoot, `.flag-response-${nonce}.json`);
  const request = {
    schemaVersion: 1,
    operation: 'flag-transition',
    runRoot: root,
    galleryRoot,
    sidecarPath: path.join(root, 'visual-flags.json'),
    responsePath,
    transition,
  };
  await fs.writeFile(requestPath, `${JSON.stringify(request)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    const result = await runPublisher(requestPath);
    if (result.code !== 0) {
      let detail = null;
      try {
        detail = JSON.parse(await fs.readFile(responsePath, 'utf8'));
      } catch {
        // The helper may fail before it can safely publish a response document.
      }
      const error = new Error(detail?.message ?? result.stderr.trim() ?? 'Reviewer flag mutation failed.');
      error.statusCode = Number.isInteger(detail?.statusCode) ? detail.statusCode : 500;
      error.code = detail?.code ?? 'GALLERY_FLAG_WRITE_FAILED';
      throw error;
    }
    const response = JSON.parse(await fs.readFile(responsePath, 'utf8'));
    return response;
  } finally {
    await Promise.all([
      fs.rm(requestPath, { force: true }),
      fs.rm(responsePath, { force: true }),
    ]);
  }
}

async function runPublisher(requestPath) {
  const child = spawn(process.execPath, [publisher, '--request', requestPath], {
    cwd: path.dirname(path.dirname(requestPath)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Reviewer flag helper exited via ${signal}.`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function galleryFlagSidecarExists(runDirectory) {
  try {
    await fs.access(path.join(path.resolve(runDirectory), 'visual-flags.json'), constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
