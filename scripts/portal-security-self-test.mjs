import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import { appendFile, chmod, chown, link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readBoundedFileTail } from '../portal/bounded-file.mjs';
import {
  resolvePortalAiWorkerIdentity,
  resolvePortalReportWorkerIdentity,
  resolvePortalRunnerIdentity,
  runnerSpawnIdentity,
  sanitizedChildEnvironment,
} from '../portal/runner-isolation.mjs';
import { publishCredentialEnvelope, removeCredentialEnvelope } from '../portal/credential-store.mjs';
import { ByteLruCache } from '../portal/byte-lru-cache.mjs';
import { openContainedArtifactFile } from '../portal/safe-artifact-open.mjs';
import { assertNoNestedMountPoints, parseMountInfoMountPoints } from '../portal/mount-boundaries.mjs';
import {
  prepareRunnerArtifactDirectory,
  removeValidatedArtifactTree,
  sealExistingPortablePath,
  withPortableArtifactWriteWindow,
} from '../portal/artifact-permissions.mjs';
import {
  applyCompletedReleaseEligibility,
  canonicalExecutionProvenance,
  portalExecutionProvenance,
  releaseReviewReasons,
} from '../portal/release-eligibility.mjs';

const fullProjects = 7;
const ready = {
  decision: 'READY',
  reason: 'Every checklist row passed.',
  decisionBasis: 'Synthetic release-truth fixture.',
};

function manifest(overrides = {}) {
  return {
    options: {
      profile: 'release',
      projects: Array.from({ length: fullProjects }, (_, index) => `project-${index + 1}`),
      auditIds: [],
      candidateIgnoreHTTPSErrors: false,
      ...overrides.options,
    },
    progress: { flaky: 0, ...overrides.progress },
    executionProvenance: overrides.executionProvenance ?? portalExecutionProvenance(),
  };
}

const portalReady = manifest();
applyCompletedReleaseEligibility(portalReady, ready, 'Synthetic pipeline complete', fullProjects);
assert.equal(portalReady.release.decision, 'READY');
assert.equal(portalReady.status, 'review-required');
assert.match(portalReady.phase, /checklist READY/i);
assert.match(portalReady.phase, /signoff withheld/i);
assert.match(portalReady.reviewReasons.join(' '), /new-ID sharded release run/i);

for (const fixture of [
  manifest({ progress: { flaky: 1 } }),
  manifest({ options: { candidateIgnoreHTTPSErrors: true } }),
  manifest({ options: { projects: ['project-1'] } }),
]) {
  applyCompletedReleaseEligibility(fixture, ready, 'Synthetic pipeline complete', fullProjects);
  assert.equal(fixture.status, 'review-required');
  assert.ok(fixture.reviewReasons.length > 0);
}

const canonicalReady = manifest({ executionProvenance: canonicalExecutionProvenance() });
applyCompletedReleaseEligibility(canonicalReady, ready, 'Canonical sharded pipeline complete', fullProjects);
assert.equal(canonicalReady.status, 'passed');
assert.deepEqual(releaseReviewReasons(canonicalReady, fullProjects), []);

const blockedWithReviews = manifest({ progress: { flaky: 2 } });
applyCompletedReleaseEligibility(blockedWithReviews, {
  decision: 'NOT_READY', reason: 'A blocking audit failed.', decisionBasis: 'Synthetic blocking fixture.',
}, 'Synthetic pipeline complete', fullProjects);
assert.equal(blockedWithReviews.status, 'not-ready');
assert.match(blockedWithReviews.phase, /release NOT READY/);
assert.match(blockedWithReviews.phase, /additional review requirements/);
assert.ok(blockedWithReviews.reviewReasons.length >= 2);

await assertRunnerIsolationContracts();
await assertPortableArtifactPermissionContracts();
await assertRaceSafeArtifactOpen();
await assertNestedMountRefusal();
await assertCredentialTransactions();
await assertComposeJobHealthPolicy();
assertBoundedReportCache();

const temporary = await mkdtemp(join(tmpdir(), 'portal-security-self-test-'));
try {
  const log = join(temporary, 'runner.log');
  await writeFile(log, `${'discarded progress line\n'.repeat(100_000)}[playwright:stdout] 99 passed\n`);
  const tail = await readBoundedFileTail(log, 32 * 1024);
  assert.equal(tail.truncated, true);
  assert.ok(tail.returnedBytes <= 32 * 1024);
  assert.match(tail.content, /99 passed/);
  await assertPortalRestartReadsLargeExternalLog(temporary);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Portal security self-test passed: operator capability isolation, runner/vault isolation, descriptor-pinned artifact reads, fail-closed portable bind mounts, sealed report publication and repeat manual mutation, mount-aware durable purge quarantine, legacy sealed-tree deletion and failure resealing, external stopping truth, transactional credentials, truthful Docker health policy, byte-bounded report caching, target availability, invalid and stale leases, active-content isolation, redacted logs, canonical metadata, and SSE recovery are enforced.');

async function assertComposeJobHealthPolicy() {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const serviceBlock = (service) => {
    const match = compose.match(new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`));
    assert.ok(match, `Compose service ${service} must exist.`);
    return match[1];
  };
  assert.doesNotMatch(serviceBlock('portal'), /healthcheck:\s*\n\s+disable:\s*true/,
    'The long-running portal must retain the image health probe.');
  for (const service of [
    'portal-e2e',
    'audit-smoke',
    'audit-release',
    'audit-release-shard',
    'audit-release-performance',
    'audit-release-merge',
    'audit-update-visuals',
  ]) {
    assert.match(serviceBlock(service), /healthcheck:\s*\n\s+disable:\s*true/,
      `${service} is a one-shot job and must not inherit the portal-only health probe.`);
  }
}

async function assertRaceSafeArtifactOpen() {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'artifact-descriptor-self-test-'));
  const run = join(root, 'run');
  const inside = join(run, 'inside');
  const moved = join(run, 'inside-pinned');
  const outside = join(root, 'outside');
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(inside, 'master.key'), 'contained-value');
  await writeFile(join(outside, 'master.key'), 'outside-secret-must-not-open');
  try {
    const opened = await openContainedArtifactFile(fsPromises, run, 'inside/master.key', {
      requireDescriptorContainment: true,
      async beforeOpenComponent({ index }) {
        if (index !== 1) return;
        await rename(inside, moved);
        await symlink(outside, inside, 'dir');
      },
    });
    try {
      assert.equal(await opened.handle.readFile('utf8'), 'contained-value',
        'Pinned descriptor traversal must survive an ancestor swap without following the replacement symlink.');
      assert.equal(opened.raceSafe, true);
    } finally {
      await opened.handle.close();
    }
    await assert.rejects(
      () => openContainedArtifactFile(fsPromises, run, 'inside/master.key', { requireDescriptorContainment: true }),
      (error) => ['ELOOP', 'ENOTDIR'].includes(error?.code),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertNestedMountRefusal() {
  const mountInfo = [
    '10 1 0:1 / / rw - ext4 /dev/root rw',
    '11 10 0:2 / /work/artifacts/runs/example-run/nested\\040mount rw - tmpfs tmpfs rw',
    '12 10 0:3 / /work/artifacts/sibling rw - tmpfs tmpfs rw',
  ].join('\n');
  assert.deepEqual(parseMountInfoMountPoints(mountInfo), [
    '/', '/work/artifacts/runs/example-run/nested mount', '/work/artifacts/sibling',
  ]);
  await assert.rejects(
    () => assertNoNestedMountPoints({
      async realpath() { return '/work/artifacts/runs/example-run'; },
      async readFile() { return mountInfo; },
    }, '/work/artifacts/runs/example-run'),
    (error) => error?.code === 'NESTED_MOUNT_POINT' && /nested mount/.test(error.message),
  );
  await assert.doesNotReject(() => assertNoNestedMountPoints({
    async realpath() { return '/work/artifacts/runs/clean-run'; },
    async readFile() { return mountInfo; },
  }, '/work/artifacts/runs/clean-run'));
  await assert.rejects(
    () => assertNoNestedMountPoints({
      async realpath() { return '/work/artifacts/runs/example-run'; },
      async readFile() { throw Object.assign(new Error('missing mount table'), { code: 'ENOENT' }); },
    }, '/work/artifacts/runs/example-run'),
    (error) => error?.code === 'MOUNT_BOUNDARY_UNAVAILABLE',
  );
}

async function assertPortableArtifactPermissionContracts() {
  const chmodModes = [];
  const bindStat = {
    uid: 501,
    gid: 20,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const unavailable = (code) => Object.assign(new Error(`synthetic bind-mount ${code} chown rejection`), { code });
  for (const code of ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']) {
    const portable = await prepareRunnerArtifactDirectory({
      async lstat() { return bindStat; },
      async chown() { throw unavailable(code); },
      async chmod(_path, mode) { chmodModes.push(mode); },
    }, '/synthetic/run', { active: true, uid: 502, gid: 20, user: 'pwuser' });
    assert.equal(portable, 'portable-bind');
  }
  assert.deepEqual(chmodModes, Array.from({ length: 5 }, () => 0o770));
  assert.equal(chmodModes.some((mode) => (mode & 0o007) !== 0), false, 'Portable delegation must never grant other/world permissions.');

  await assert.rejects(() => prepareRunnerArtifactDirectory({
    async lstat() { return { ...bindStat, uid: 0, gid: 0 }; },
    async chown() { throw unavailable('EACCES'); },
    async chmod() { throw new Error('Unsafe root-owned bind must fail before chmod.'); },
  }, '/synthetic/root-owned-run', { active: true, uid: 501, gid: 20, user: 'pwuser' }), /cannot be delegated safely.*worker group/i);

  const root = await mkdtemp(join(tmpdir(), 'portable-artifact-self-test-'));
  try {
    const run = join(root, 'run');
    const logs = join(run, 'logs');
    const runnerLog = join(logs, 'runner.log');
    const manual = join(run, 'manual-evidence');
    const manualIndex = join(run, 'manual-evidence.json');
    await mkdir(logs, { recursive: true });
    await mkdir(manual, { recursive: true });
    await writeFile(runnerLog, 'initial\n');
    await writeFile(manualIndex, '{"schemaVersion":1,"uploads":[],"entries":[]}\n');
    await sealExistingPortablePath(fsPromises, run);

    for (const index of [1, 2]) {
      await withPortableArtifactWriteWindow(
        fsPromises,
        run,
        {
          active: true,
          writablePaths: [logs, runnerLog, manual, manualIndex],
          sealPaths: [logs, manual, manualIndex],
        },
        async () => {
          const rootMode = (await lstat(run)).mode & 0o777;
          assert.equal(rootMode, 0o750, 'The supervisor window must never make the sealed parent group-writable.');
          await appendFile(runnerLog, `manual mutation ${index}\n`);
          await writeFile(join(manual, `upload-${index}.png`), `synthetic-${index}`);
          await writeFile(manualIndex, `{"schemaVersion":1,"mutation":${index}}\n`);
        },
      );
      assert.equal((await lstat(run)).mode & 0o777, 0o550);
      assert.equal((await lstat(logs)).mode & 0o777, 0o550);
      assert.equal((await lstat(runnerLog)).mode & 0o777, 0o440);
      assert.equal((await lstat(manual)).mode & 0o777, 0o550);
      assert.equal((await lstat(manualIndex)).mode & 0o777, 0o440);
    }
    assert.match(await readFile(runnerLog, 'utf8'), /manual mutation 1[\s\S]*manual mutation 2/,
      'Repeated manual operations must reopen, append, and reseal the persistent log.');

    let checklist = join(run, 'checklist');
    for (const index of [1, 2]) {
      const staging = await withPortableArtifactWriteWindow(
        fsPromises, run, { active: true },
        () => mkdtemp(join(run, '.checklist-staging-')),
      );
      await writeFile(join(staging, 'manifest.json'), `{"publication":${index}}\n`);
      if (index === 2) await symlink('/etc/passwd', join(staging, 'untrusted-link'));
      await withPortableArtifactWriteWindow(
        fsPromises, run, {
          active: true,
          recursiveWritablePaths: [checklist, staging],
          sealPaths: [checklist],
          removeSealSymlinks: true,
        }, async () => {
          const backup = join(run, `.checklist-backup-${index}`);
          try {
            await rename(checklist, backup);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          await rename(staging, checklist);
          await rm(backup, { recursive: true, force: true });
        },
      );
      assert.equal(JSON.parse(await readFile(join(checklist, 'manifest.json'), 'utf8')).publication, index,
        'Each private checklist publication must replace the prior nested tree.');
      assert.equal((await lstat(run)).mode & 0o777, 0o550);
      assert.equal((await lstat(checklist)).mode & 0o777, 0o550);
      if (index === 2) {
        await assert.rejects(() => lstat(join(checklist, 'untrusted-link')), { code: 'ENOENT' });
      }
    }

    const strandedBackup = join(run, '.checklist-backup-interrupted');
    await assert.rejects(() => withPortableArtifactWriteWindow(
      fsPromises,
      run,
      {
        active: true,
        recursiveWritablePaths: [checklist],
        sealPaths: [checklist, strandedBackup],
      },
      async () => {
        await rename(checklist, strandedBackup);
        throw new Error('synthetic publication interruption before rollback');
      },
    ), /synthetic publication interruption/);
    assert.equal((await lstat(run)).mode & 0o777, 0o550);
    assert.equal((await lstat(strandedBackup)).mode & 0o777, 0o550,
      'A backup stranded by failed publication rollback must be resealed.');
    await withPortableArtifactWriteWindow(
      fsPromises,
      run,
      { active: true, writablePaths: [strandedBackup], sealPaths: [checklist] },
      () => rename(strandedBackup, checklist),
    );

    await assertLegacySealedTreeDeletion(root);

    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
      await assertReportWorkerCannotRenameSealedEvidence(root, run, checklist);
    }
  } finally {
    await makeTreeWritableForCleanup(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertLegacySealedTreeDeletion(outerRoot) {
  const outside = join(outerRoot, 'purge-outside-retained.txt');
  const legacy = join(outerRoot, 'legacy-sealed-run');
  const evidence = join(legacy, 'evidence', 'nested');
  const checklist = join(legacy, 'checklist', 'data');
  await mkdir(evidence, { recursive: true });
  await mkdir(checklist, { recursive: true });
  await writeFile(outside, 'outside reference must survive purge');
  const outsideMode = (await lstat(outside)).mode & 0o777;
  await writeFile(join(evidence, 'legacy-video.webm'), 'sealed video');
  await writeFile(join(checklist, 'audit.json'), '{"sealed":true}\n');
  await link(outside, join(evidence, 'retained-hardlink'));
  await symlink(outside, join(checklist, 'retained-symlink'));
  for (const file of [join(evidence, 'legacy-video.webm'), join(checklist, 'audit.json')]) await chmod(file, 0o440);
  for (const directory of [evidence, dirname(evidence), checklist, dirname(checklist), legacy]) await chmod(directory, 0o550);

  await removeValidatedArtifactTree(fsPromises, legacy);
  await assert.rejects(() => lstat(legacy), { code: 'ENOENT' });
  assert.equal(await readFile(outside, 'utf8'), 'outside reference must survive purge',
    'Legacy purge must unlink contained symlink/hardlink references without following or mutating the retained target.');
  assert.equal((await lstat(outside)).mode & 0o777, outsideMode,
    'Legacy purge must not chmod an inode retained through an outside hard link.');

  const retained = join(outerRoot, 'legacy-purge-failure');
  const retainedNested = join(retained, 'evidence', 'nested');
  const retainedFile = join(retainedNested, 'result.json');
  await mkdir(retainedNested, { recursive: true });
  await writeFile(retainedFile, '{"retained":true}\n');
  await chmod(retainedFile, 0o440);
  await chmod(retainedNested, 0o550);
  await chmod(dirname(retainedNested), 0o550);
  await chmod(retained, 0o550);
  const deletionFailure = Object.assign(new Error('synthetic recursive deletion failure'), { code: 'EIO' });
  await assert.rejects(() => removeValidatedArtifactTree({
    ...fsPromises,
    async rm() { throw deletionFailure; },
  }, retained), /synthetic recursive deletion failure/);
  assert.equal((await lstat(retained)).mode & 0o777, 0o550,
    'A failed legacy purge must retain and reseal its run root.');
  assert.equal((await lstat(retainedNested)).mode & 0o777, 0o550,
    'A failed legacy purge must reseal nested evidence directories.');
  assert.equal((await lstat(retainedFile)).mode & 0o777, 0o440,
    'A failed legacy purge must not broaden retained file permissions.');

  const escapedRoot = join(outerRoot, 'legacy-purge-root-link');
  await symlink(retained, escapedRoot, 'dir');
  await assert.rejects(() => removeValidatedArtifactTree(fsPromises, escapedRoot), /root must be a real directory/i);
  assert.equal(await readFile(retainedFile, 'utf8'), '{"retained":true}\n');
  await unlink(escapedRoot);
}

async function makeTreeWritableForCleanup(path) {
  let details;
  try {
    details = await fsPromises.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!details.isDirectory()) return fsPromises.chmod(path, 0o640);
  await fsPromises.chmod(path, 0o750);
  for (const entry of await fsPromises.readdir(path)) await makeTreeWritableForCleanup(join(path, entry));
}

async function assertReportWorkerCannotRenameSealedEvidence(outerRoot, run, checklist) {
  const runnerUid = 61_001;
  const reportUid = 61_002;
  const artifactGid = 61_000;
  const staging = join(run, '.report-worker-staging');
  await chmod(outerRoot, 0o755);
  await mkdir(staging, { mode: 0o770 });
  await chown(run, runnerUid, artifactGid);
  await chown(checklist, runnerUid, artifactGid);
  await chown(staging, runnerUid, artifactGid);
  await chmod(run, 0o550);
  await chmod(checklist, 0o550);
  await chmod(staging, 0o770);
  const probe = spawn(process.execPath, ['-e', [
    "const fs=require('node:fs')",
    "let renameBlocked=false",
    "try{fs.renameSync(process.argv[1],process.argv[2])}catch{renameBlocked=true}",
    "let stagingWritable=true",
    "try{fs.writeFileSync(process.argv[3],'report output')}catch{stagingWritable=false}",
    "process.exit(renameBlocked&&stagingWritable?0:9)",
  ].join(';'), checklist, join(run, 'worker-stole-checklist'), join(staging, 'report.json')], {
    uid: reportUid,
    gid: artifactGid,
    stdio: 'ignore',
  });
  const [exitCode] = await once(probe, 'exit');
  assert.equal(exitCode, 0, 'The report worker may write only its staging directory and cannot rename sealed source evidence.');
}

async function assertRunnerIsolationContracts() {
  const unset = resolvePortalRunnerIdentity({}, process.platform, typeof process.getuid === 'function' ? process.getuid() : null);
  assert.equal(unset.active, false);
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    assert.throws(() => resolvePortalRunnerIdentity({ PORTAL_RUNNER_UID: '1000', PORTAL_RUNNER_GID: '1000' }, process.platform, null), /POSIX/);
    return;
  }
  const unitPortalUid = process.getuid() === 0 ? 60_003 : process.getuid();
  assert.throws(() => resolvePortalRunnerIdentity({ PORTAL_RUNNER_UID: '1000' }, process.platform, unitPortalUid), /configured together/);
  assert.throws(() => resolvePortalRunnerIdentity({ PORTAL_RUNNER_UID: '0', PORTAL_RUNNER_GID: '1000' }, process.platform, unitPortalUid), /integer from 1/);
  const distinctUid = unitPortalUid === 60_001 ? 60_002 : 60_001;
  assert.throws(() => resolvePortalRunnerIdentity({
    PORTAL_RUNNER_UID: String(unitPortalUid),
    PORTAL_RUNNER_GID: '60001',
  }, process.platform, unitPortalUid), /must differ/);
  const identity = resolvePortalRunnerIdentity({
    PORTAL_RUNNER_UID: String(distinctUid),
    PORTAL_RUNNER_GID: '60001',
  }, process.platform, unitPortalUid);
  assert.deepEqual(runnerSpawnIdentity(identity), { uid: distinctUid, gid: 60_001 });
  const aiUid = distinctUid === 60_002 ? 60_004 : 60_002;
  assert.throws(() => resolvePortalAiWorkerIdentity({
    PORTAL_AI_WORKER_UID: String(aiUid),
    PORTAL_AI_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, unset), /requires an active isolated Playwright runner/);
  assert.throws(() => resolvePortalAiWorkerIdentity({
    PORTAL_AI_WORKER_UID: String(distinctUid),
    PORTAL_AI_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, identity), /must differ from the Playwright runner UID/);
  assert.throws(() => resolvePortalAiWorkerIdentity({
    PORTAL_AI_WORKER_UID: String(aiUid),
    PORTAL_AI_WORKER_GID: '60002',
  }, process.platform, unitPortalUid, identity), /must match the Playwright runner GID/);
  const aiIdentity = resolvePortalAiWorkerIdentity({
    PORTAL_AI_WORKER_UID: String(aiUid),
    PORTAL_AI_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, identity);
  assert.deepEqual(runnerSpawnIdentity(aiIdentity), { uid: aiUid, gid: 60_001 });
  const reportUid = aiUid === 60_004 ? 60_005 : 60_004;
  assert.throws(() => resolvePortalReportWorkerIdentity({
    PORTAL_REPORT_WORKER_UID: String(reportUid),
    PORTAL_REPORT_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, identity, { active: false }), /requires isolated Playwright and AI worker/);
  assert.throws(() => resolvePortalReportWorkerIdentity({
    PORTAL_REPORT_WORKER_UID: String(aiUid),
    PORTAL_REPORT_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, identity, aiIdentity), /must differ from both/);
  const reportIdentity = resolvePortalReportWorkerIdentity({
    PORTAL_REPORT_WORKER_UID: String(reportUid),
    PORTAL_REPORT_WORKER_GID: '60001',
  }, process.platform, unitPortalUid, identity, aiIdentity);
  assert.deepEqual(runnerSpawnIdentity(reportIdentity), { uid: reportUid, gid: 60_001 });
  const childEnvironment = sanitizedChildEnvironment({
    ANTHROPIC_API_KEY: 'synthetic-must-not-cross-boundary',
    PORTAL_SECRET_ROOT: '/synthetic/secret-root',
    PORTAL_E2E_OPERATOR_TOKEN: 'synthetic-operator-capability',
    HOME: '/portal/root',
    SAFE_VALUE: 'retained',
  }, identity);
  assert.equal(childEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnvironment.PORTAL_SECRET_ROOT, undefined);
  assert.equal(childEnvironment.PORTAL_E2E_OPERATOR_TOKEN, undefined);
  assert.equal(childEnvironment.HOME, '/home/pwuser');
  assert.equal(childEnvironment.USER, 'pwuser');
  assert.equal(childEnvironment.LOGNAME, 'pwuser');
  assert.equal(childEnvironment.XDG_CACHE_HOME, '/home/pwuser/.cache');
  assert.equal(childEnvironment.SAFE_VALUE, 'retained');
  const aiEnvironment = sanitizedChildEnvironment({
    ANTHROPIC_API_KEY: 'synthetic-must-not-be-in-ai-environment',
    PORTAL_SECRET_ROOT: '/synthetic/secret-root',
  }, aiIdentity);
  assert.equal(aiEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(aiEnvironment.PORTAL_SECRET_ROOT, undefined);
  assert.equal(aiEnvironment.HOME, '/home/aiworker');
  assert.equal(aiEnvironment.USER, 'aiworker');
  const reportEnvironment = sanitizedChildEnvironment({
    ANTHROPIC_API_KEY: 'synthetic-must-not-be-in-report-environment',
    PORTAL_SECRET_ROOT: '/synthetic/secret-root',
  }, reportIdentity);
  assert.equal(reportEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(reportEnvironment.PORTAL_SECRET_ROOT, undefined);
  assert.equal(reportEnvironment.HOME, '/home/reportworker');
  assert.equal(reportEnvironment.USER, 'reportworker');

  // Docker runs this self-test as the secret-owning root process. Exercise the
  // real kernel boundary there instead of relying only on environment shape.
  if (process.getuid() !== 0) return;
  const root = await mkdtemp(join(tmpdir(), 'portal-runner-vault-self-test-'));
  try {
    const vault = join(root, 'vault');
    await mkdir(vault, { mode: 0o700 });
    const master = join(vault, 'master.key');
    const credential = join(vault, 'anthropic-key.json');
    await writeFile(master, 'synthetic-master-key', { mode: 0o600 });
    await writeFile(credential, '{"synthetic":true}\n', { mode: 0o600 });
    await chmod(root, 0o700);
    for (const [label, uid] of [['Playwright', distinctUid], ['AI worker', aiUid], ['report worker', reportUid]]) {
      const probe = spawn(process.execPath, [
        '-e',
        "const fs=require('node:fs');const readable=process.argv.slice(1).filter((p)=>{try{fs.readFileSync(p);return true}catch{return false}});process.exit(readable.length===0?0:9)",
        master,
        credential,
      ], {
        uid,
        gid: 60_001,
        stdio: 'ignore',
      });
      const [exitCode] = await once(probe, 'exit');
      assert.equal(exitCode, 0, `${label} UID must not be able to read master.key or anthropic-key.json.`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertCredentialTransactions() {
  const calls = [];
  const renameFailure = Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
  await assert.rejects(() => publishCredentialEnvelope({
    async writeFile(path) { calls.push(['write', path]); },
    async rename(from, to) { calls.push(['rename', from, to]); throw renameFailure; },
    async unlink(path) { calls.push(['unlink', path]); },
  }, '/vault/key.json', '/vault/key.tmp', '{}\n'), /synthetic rename failure/);
  assert.deepEqual(calls.map(([operation]) => operation), ['write', 'rename', 'unlink']);

  let inMemoryCredential = 'retained-until-durable-delete';
  await assert.rejects(async () => {
    await removeCredentialEnvelope({
      async unlink() { throw Object.assign(new Error('synthetic unlink failure'), { code: 'EIO' }); },
    }, '/vault/key.json');
    inMemoryCredential = null;
  }, /synthetic unlink failure/);
  assert.equal(inMemoryCredential, 'retained-until-durable-delete');
  assert.equal(await removeCredentialEnvelope({
    async unlink() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }, '/vault/key.json'), false);
}

function assertBoundedReportCache() {
  const cache = new ByteLruCache(3, 10);
  cache.set('a', { id: 'a' }, 4);
  cache.set('b', { id: 'b' }, 4);
  assert.equal(cache.get('a').id, 'a', 'A cache hit must refresh recency.');
  cache.set('c', { id: 'c' }, 4);
  assert.equal(cache.get('b'), undefined, 'Byte pressure must evict the least-recently-used entry.');
  assert.equal(cache.totalBytes, 8);
  cache.set('oversized', { id: 'oversized' }, 11);
  assert.equal(cache.get('oversized'), undefined, 'An individually oversized report must not enter the cache.');
  assert(cache.size <= 3);
  assert(cache.totalBytes <= 10);
}

async function assertPortalRestartReadsLargeExternalLog(temporary) {
  const operatorToken = 'portal-e2e-operator-capability-0123456789abcdef';
  const artifacts = join(temporary, 'restart-runs');
  const sharded = join(temporary, 'restart-sharded');
  const secrets = join(temporary, 'restart-secrets');
  const logDirectory = join(sharded, 'restart-large-log', 'logs');
  const staleDirectory = join(sharded, 'stale-external-run');
  const malformedDirectory = join(sharded, 'malformed-external-run');
  const oversizedDirectory = join(sharded, 'oversized-external-run');
  const stoppingDirectory = join(sharded, 'stopping-external-run');
  const quarantinedRunId = 'durable-purge-run';
  const quarantineName = `${quarantinedRunId}-0123456789abcdef`;
  const syntheticKey = ['sk', 'ant', 'download-guard', 'x'.repeat(32)].join('-');
  await mkdir(logDirectory, { recursive: true });
  await mkdir(join(staleDirectory, 'logs'), { recursive: true });
  await mkdir(join(malformedDirectory, 'logs'), { recursive: true });
  await mkdir(join(oversizedDirectory, 'logs'), { recursive: true });
  await mkdir(join(stoppingDirectory, 'logs'), { recursive: true });
  const quarantineDirectory = join(artifacts, '.portal-purge-quarantine', quarantineName);
  const purgeJournalDirectory = join(secrets, 'purge-journals');
  await mkdir(quarantineDirectory, { recursive: true });
  await mkdir(purgeJournalDirectory, { recursive: true });
  await writeFile(join(quarantineDirectory, 'remaining-evidence.json'), '{"partial":true}\n');
  const timestamp = new Date().toISOString();
  await writeFile(join(logDirectory, 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"restart-large-log","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\nx-api-key=${syntheticKey}\n`);
  await writeFile(join(logDirectory, 'shard-1-of-1.log'), `${timestamp} [SHARD 1/1][stdout] Running 24000 tests using 1 worker, shard 1 of 1\n${'[AUDIT_TEST_FINISH] passed\n'.repeat(24_000)}`);
  await writeFile(join(sharded, 'restart-large-log', 'sharded-heartbeat.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId: 'restart-large-log',
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    activeCommands: 1,
    progress: {
      'shard-1-of-1.log': {
        kind: 'shard', index: 1, total: 24_000, completed: 24_000, auditFinishes: 24_000,
        passed: null, failed: null, flaky: null, skipped: null, didNotRun: null,
        finished: false, updatedAt: timestamp,
      },
    },
  })}\n`);
  await writeFile(join(sharded, 'restart-large-log', 'active-content.html'), '<!doctype html><script>fetch("/api/settings/anthropic-key",{method:"DELETE",headers:{"content-type":"application/json"}})</script>');
  await writeFile(join(staleDirectory, 'logs', 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"stale-external-run","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
  await writeFile(join(malformedDirectory, 'logs', 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"malformed-external-run","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
  await writeFile(join(oversizedDirectory, 'logs', 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"oversized-external-run","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
  await writeFile(join(stoppingDirectory, 'logs', 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"stopping-external-run","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
  await writeFile(join(staleDirectory, 'sharded-heartbeat.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId: 'stale-external-run',
    status: 'running',
    updatedAt: '2026-01-01T00:00:00.000Z',
    leaseExpiresAt: '2026-01-01T00:00:01.000Z',
    activeCommands: 0,
  })}\n`);
  await writeFile(join(malformedDirectory, 'sharded-heartbeat.json'), '{}\n');
  await writeFile(join(oversizedDirectory, 'sharded-run.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId: 'oversized-external-run',
    padding: 'x'.repeat(300 * 1024),
  })}\n`);
  await writeFile(join(stoppingDirectory, 'sharded-heartbeat.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId: 'stopping-external-run',
    status: 'stopping',
    updatedAt: timestamp,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    activeCommands: 2,
  })}\n`);
  const purgeRootKey = createHash('sha256').update(resolve(artifacts)).digest('hex').slice(0, 16);
  const purgeJournalPath = join(purgeJournalDirectory, `${purgeRootKey}-${quarantinedRunId}.json`);
  await writeFile(purgeJournalPath, `${JSON.stringify({
    schemaVersion: 1,
    id: quarantinedRunId,
    source: 'portal-managed',
    quarantineName,
    status: 'deleting',
    preparedAt: timestamp,
    manifest: {
      schemaVersion: 1,
      id: quarantinedRunId,
      status: 'not-ready',
      phase: 'Synthetic pre-crash purge fixture',
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      options: { candidateIgnoreHTTPSErrors: false, projects: [], targetIds: [], pluginIds: [], areas: [], auditIds: [] },
      progress: { total: 1, completed: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 },
      stages: {},
    },
  })}\n`, { mode: 0o600 });

  const port = await availablePort();
  const portalEnvironment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PORTAL_ARTIFACT_ROOT: artifacts,
    PORTAL_SHARDED_ARTIFACT_ROOT: sharded,
    PORTAL_SECRET_ROOT: secrets,
    PORTAL_E2E_FAILURE_INJECTION: '1',
    PORTAL_E2E_OPERATOR_TOKEN: operatorToken,
  };
  delete portalEnvironment.PORTAL_RUNNER_UID;
  delete portalEnvironment.PORTAL_RUNNER_GID;
  delete portalEnvironment.PORTAL_AI_WORKER_UID;
  delete portalEnvironment.PORTAL_AI_WORKER_GID;
  delete portalEnvironment.PORTAL_REPORT_WORKER_UID;
  delete portalEnvironment.PORTAL_REPORT_WORKER_GID;
  delete portalEnvironment.ANTHROPIC_API_KEY;
  const child = spawn(process.execPath, ['portal/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: portalEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Portal restart probe exited ${child.exitCode}: ${stderr.slice(-2_000)}`);
      let connected = false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          connected = true;
          const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
          assert.ok(config.catalog.length > 0);
          assert.equal(typeof config.catalog[0].userPromise, 'string');
          assert.equal(typeof config.catalog[0].releaseBlocking, 'boolean');
          assert.equal(typeof config.catalog[0].evidencePolicy?.mode, 'string');
          assert.ok(config.plugins.every(({ auditCases }) => Array.isArray(auditCases)));
          assert.equal(config.targets.localTargets.length, 14);
          assert.equal(config.targets.providerTargets.length, 4);
          assert.equal(config.targets.defaultTargetIds.length, 7);
          assert.equal(config.defaults.releaseShardTotal, 8);
          assert.equal(config.defaults.releaseShardWorkers, 1);
          assert.equal(config.defaults.releaseShardConcurrency, 4);
          assert.ok(config.targets.localTargets.every(({ id, fidelity, qualification, defaultSelected }) => (
            typeof id === 'string' && typeof fidelity === 'string' && typeof qualification === 'string'
            && typeof defaultSelected === 'boolean'
          )));
          assert.ok(config.targets.providerTargets.every(({ available, defaultSelected, runnable }) => (
            available === false && defaultSelected === false && runnable === false
          )));
          assert.equal(config.runnerIsolation.active, false);
          assert.equal(config.runnerIsolation.aiWorkerActive, false);
          assert.equal(config.runnerIsolation.reportWorkerActive, false);
          assert.equal(config.runnerIsolation.credentialStorageEnabled, false);
          assert.equal(config.operator.authorized, false);
          const portalOrigin = `http://127.0.0.1:${port}`;
          const invalidInlineUnlock = await fetch(`${portalOrigin}/api/operator/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: portalOrigin },
            body: JSON.stringify({ token: 'invalid' }),
          });
          assert.equal(invalidInlineUnlock.status, 403);
          const crossOriginInlineUnlock = await fetch(`${portalOrigin}/api/operator/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test' },
            body: JSON.stringify({ token: operatorToken }),
          });
          assert.equal(crossOriginInlineUnlock.status, 403,
            'A valid capability must not bypass the same-origin browser boundary.');
          const sandboxedInlineUnlock = await fetch(`${portalOrigin}/api/operator/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'null' },
            body: JSON.stringify({ token: operatorToken }),
          });
          assert.equal(sandboxedInlineUnlock.status, 403,
            'Sandboxed artifact documents must not establish an operator browser session.');
          const inlineUnlock = await fetch(`${portalOrigin}/api/operator/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: portalOrigin },
            body: JSON.stringify({ token: operatorToken }),
          });
          assert.equal(inlineUnlock.status, 200);
          assert.deepEqual(await inlineUnlock.json(), { authorized: true });
          assert.match(inlineUnlock.headers.get('set-cookie') ?? '', /^portal_operator=[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);
          const operatorCookie = (inlineUnlock.headers.get('set-cookie') ?? '').split(';', 1)[0];
          const inlineAuthorizedConfig = await (await fetch(`${portalOrigin}/api/config`, {
            headers: { Cookie: operatorCookie },
          })).json();
          assert.equal(inlineAuthorizedConfig.operator.authorized, true,
            'The in-page exchange must authorize the browser without returning the session token to JavaScript.');
          const invalidBootstrap = await fetch(`http://127.0.0.1:${port}/operator/bootstrap?token=invalid`, {
            redirect: 'manual',
          });
          assert.equal(invalidBootstrap.status, 403);
          const bootstrap = await fetch(`http://127.0.0.1:${port}/operator/bootstrap?token=${operatorToken}`, {
            redirect: 'manual',
          });
          assert.equal(bootstrap.status, 303);
          assert.equal(bootstrap.headers.get('location'), '/');
          assert.match(bootstrap.headers.get('set-cookie') ?? '', /^portal_operator=[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);
          const authorizedConfig = await (await fetch(`http://127.0.0.1:${port}/api/config`, {
            headers: { Cookie: operatorCookie },
          })).json();
          assert.equal(authorizedConfig.operator.authorized, true,
            'The one-time unlock exchange must authorize the browser without exposing the capability to JavaScript.');
          const keyState = await (await fetch(`http://127.0.0.1:${port}/api/settings/anthropic-key`)).json();
          assert.equal(keyState.configured, false);
          assert.equal(keyState.storageEnabled, false);
          const unauthorizedMutation = await fetch(`http://127.0.0.1:${port}/api/settings/anthropic-key`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: syntheticKey }),
          });
          assert.equal(unauthorizedMutation.status, 401,
            'An origin-less process on the portal loopback socket must not receive operator mutation authority.');
          const unauthorizedVisualReview = await fetch(
            `http://127.0.0.1:${port}/api/single-site/runs/forged/gallery/items/gitem_0000000000000000/review`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            },
          );
          assert.equal(unauthorizedVisualReview.status, 401,
            'Human visual dispositions must require operator mutation authority before run or body processing.');
          const rejectedKeySave = await fetch(`http://127.0.0.1:${port}/api/settings/anthropic-key`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
            body: JSON.stringify({ apiKey: syntheticKey }),
          });
          assert.equal(rejectedKeySave.status, 503);
          const sandboxedMutation = await fetch(`http://127.0.0.1:${port}/api/settings/anthropic-key`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Origin: 'null', 'X-Portal-Operator-Token': operatorToken },
          });
          assert.equal(sandboxedMutation.status, 403);

          for (const targetIds of [
            [config.targets.providerTargets[0].id],
            [config.targets.defaultTargetIds[0], config.targets.defaultTargetIds[0]],
            ['unknown-browser-target'],
          ]) {
            const rejectedTarget = await fetch(`http://127.0.0.1:${port}/api/runs`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Portal-Operator-Token': operatorToken },
              body: JSON.stringify({
                profile: 'smoke', targetIds, areas: [], auditIds: [], pluginIds: [],
                productionUrl: 'https://quitting7oh.org',
                candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
                candidateIgnoreHTTPSErrors: false, aiReview: false,
              }),
            });
            assert.equal(rejectedTarget.status, 400);
          }
          const applicabilityGap = config.plugins.flatMap((plugin) => plugin.auditDefinitions
            .filter(({ manual }) => !manual)
            .map((definition) => {
              const supported = new Set(plugin.auditCases
                .filter(({ auditId }) => auditId === definition.id)
                .flatMap(({ supportedProjects }) => supportedProjects));
              return { auditId: definition.id, project: plugin.supportedProjects.find((project) => !supported.has(project)) };
            }))
            .find(({ project }) => project);
          assert.ok(applicabilityGap, 'Expected a synthetic target mismatch for portal launch validation.');
          const rejectedLaunch = await fetch(`http://127.0.0.1:${port}/api/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Portal-Operator-Token': operatorToken },
            body: JSON.stringify({
              profile: 'smoke',
              targetIds: [applicabilityGap.project],
              areas: [],
              auditIds: [applicabilityGap.auditId],
              pluginIds: [],
              productionUrl: 'https://quitting7oh.org',
              candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
              candidateIgnoreHTTPSErrors: false,
              aiReview: false,
            }),
          });
          assert.equal(rejectedLaunch.status, 400);
          assert.match((await rejectedLaunch.json()).error, /no executable test case/i);

          const runDeadline = Date.now() + 5_000;
          let staleRun;
          while (Date.now() < runDeadline) {
            const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
            staleRun = runs.runs.find(({ id }) => id === 'stale-external-run');
            if (staleRun?.status === 'evidence-failed') break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal(staleRun?.status, 'evidence-failed');
          assert.match(staleRun.phase, /stopped reporting progress/i);
          const malformedRun = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json())
            .runs.find(({ id }) => id === 'malformed-external-run');
          assert.equal(malformedRun?.status, 'evidence-failed');
          assert.match(malformedRun.phase, /invalid heartbeat/i);
          const oversizedRun = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json())
            .runs.find(({ id }) => id === 'oversized-external-run');
          assert.equal(oversizedRun?.status, 'evidence-failed');
          assert.match(oversizedRun.phase, /invalid lifecycle evidence/i);
          const stoppingRun = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json())
            .runs.find(({ id }) => id === 'stopping-external-run');
          assert.equal(stoppingRun?.status, 'stopping');
          assert.match(stoppingRun.phase, /2 command\(s\) still active/i);
          const quarantinedRun = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json())
            .runs.find(({ id }) => id === quarantinedRunId);
          assert.equal(quarantinedRun?.status, 'evidence-failed');
          assert.equal(quarantinedRun?.purgeFailure?.quarantined, true);
          assert.match(quarantinedRun?.phase ?? '', /purge incomplete/i);
          if (process.platform === 'linux') {
            const retry = await fetch(`http://127.0.0.1:${port}/api/runs/${quarantinedRunId}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', 'X-Portal-Operator-Token': operatorToken },
              body: JSON.stringify({ confirmation: `PURGE ${quarantinedRunId}` }),
            });
            assert.equal(retry.status, 200, await retry.text());
            await assert.rejects(() => lstat(purgeJournalPath), { code: 'ENOENT' });
          }

          const restartedRun = await (await fetch(`http://127.0.0.1:${port}/api/runs/restart-large-log`)).json();
          assert.equal(restartedRun.progress.completed, 24_000,
            'The bounded heartbeat sidecar must restore exact progress without rescanning an omitted log prefix.');
          const diagnosticsBefore = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()).externalSync;
          const coldRunDirectory = join(sharded, 'cold-large-log');
          await mkdir(join(coldRunDirectory, 'logs'), { recursive: true });
          await writeFile(join(coldRunDirectory, 'logs', 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"cold-large-log","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
          await writeFile(join(coldRunDirectory, 'logs', 'shard-1-of-1.log'), `${timestamp} [SHARD 1/1][stdout] Running 300000 tests using 1 worker, shard 1 of 1\n${'[AUDIT_TEST_FINISH] passed\n'.repeat(300_000)}`);
          const coldHeartbeatTimestamp = new Date().toISOString();
          await writeFile(join(coldRunDirectory, 'sharded-heartbeat.json'), `${JSON.stringify({
            schemaVersion: 1,
            runId: 'cold-large-log',
            status: 'running',
            startedAt: coldHeartbeatTimestamp,
            updatedAt: coldHeartbeatTimestamp,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            activeCommands: 1,
          })}\n`);
          const listStartedAt = performance.now();
          const listResponse = await fetch(`http://127.0.0.1:${port}/api/runs`);
          assert.equal(listResponse.status, 200);
          assert.ok(performance.now() - listStartedAt < 500,
            'Known-run list reads must return cached state without awaiting cold external-log ingestion.');
          const detailStartedAt = performance.now();
          const detailResponses = await Promise.all(Array.from({ length: 8 }, () =>
            fetch(`http://127.0.0.1:${port}/api/runs/restart-large-log`)));
          assert.ok(detailResponses.every(({ status }) => status === 200));
          assert.ok(performance.now() - detailStartedAt < 2_000,
            'Known-run detail reads must remain responsive while a cold external refresh is active.');
          const syncDeadline = Date.now() + 5_000;
          let syncDiagnostics;
          while (Date.now() < syncDeadline) {
            syncDiagnostics = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()).externalSync;
            if (syncDiagnostics.status === 'idle'
              && syncDiagnostics.finishedAt !== diagnosticsBefore.finishedAt
              && syncDiagnostics.skippedBytes > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(syncDiagnostics?.status, 'idle');
          assert.ok(syncDiagnostics?.bytesRead <= 2 * 1024 * 1024,
            'A refresh must obey its global byte budget.');
          assert.ok(syncDiagnostics?.skippedBytes > 0,
            `A cold large log must be tail-seeded without reading its entire omitted prefix: ${JSON.stringify(syncDiagnostics)}`);

          const artifacts = await (await fetch(`http://127.0.0.1:${port}/api/runs/restart-large-log/artifacts?limit=500`)).json();
          assert.equal(artifacts.files.some(({ path }) => path.startsWith('logs/') || path.endsWith('.log')), false);
          const rawLog = await fetch(`http://127.0.0.1:${port}/artifacts/restart-large-log/logs/coordinator.log`);
          assert.equal(rawLog.status, 404);
          const redacted = await (await fetch(`http://127.0.0.1:${port}/api/runs/restart-large-log/logs?maxBytes=65536`)).json();
          assert.equal(redacted.log.includes(syntheticKey), false);
          assert.match(redacted.log, /\[REDACTED(?:_ANTHROPIC_KEY)?\]/);
          const activeContent = await fetch(`http://127.0.0.1:${port}/artifacts/restart-large-log/active-content.html`);
          assert.equal(activeContent.status, 200);
          const artifactCsp = activeContent.headers.get('content-security-policy') ?? '';
          assert.match(artifactCsp, /sandbox/);
          assert.doesNotMatch(artifactCsp, /allow-same-origin/);
          await assertSseBackpressureRecovery(port, join(logDirectory, 'shard-1-of-1.log'));
          return;
        }
      } catch (error) {
        if (connected) throw error;
        // The listener is expected to race the first few probes.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Portal restart probe did not become healthy: ${stderr.slice(-2_000)}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

async function assertSseBackpressureRecovery(port, externalLogPath) {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write([
    'GET /api/runs/restart-large-log/events HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Accept: text/event-stream',
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  let initial = '';
  while (!initial.includes('event: snapshot')) {
    const [chunk] = await once(socket, 'data');
    initial += chunk.toString();
  }
  socket.pause();
  const payload = `${'x'.repeat(2_000)}\n`.repeat(1_500);
  await appendFile(externalLogPath, payload);
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  let recovered = '';
  const deadline = Date.now() + 10_000;
  socket.resume();
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        once(socket, 'data').then(([value]) => value),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE recovery timed out.')), remaining)),
      ]);
      recovered += chunk.toString();
      const overflow = recovered.lastIndexOf('event: overflow');
      if (overflow >= 0 && recovered.indexOf('event: snapshot', overflow) > overflow) return;
      if (recovered.length > 2 * 1024 * 1024) recovered = recovered.slice(-1024 * 1024);
    }
    throw new Error('SSE recovery omitted its overflow notice or authoritative snapshot.');
  } finally {
    socket.destroy();
  }
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not allocate a portal restart probe port.');
  return port;
}
