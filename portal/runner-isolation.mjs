const MAX_POSIX_ID = 2_147_483_647;

function posixId(value, name) {
  if (!/^[1-9]\d*$/.test(value ?? '')) throw new Error(`${name} must be an integer from 1 to ${MAX_POSIX_ID}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_POSIX_ID) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_POSIX_ID}.`);
  }
  return parsed;
}

export function resolvePortalRunnerIdentity(
  environment = process.env,
  platform = process.platform,
  portalUid = typeof process.getuid === 'function' ? process.getuid() : null,
) {
  const rawUid = environment.PORTAL_RUNNER_UID;
  const rawGid = environment.PORTAL_RUNNER_GID;
  if (rawUid === undefined && rawGid === undefined) {
    return {
      active: false,
      uid: null,
      gid: null,
      user: null,
      home: null,
      reason: 'A separate Playwright runner identity is not configured.',
    };
  }
  if (rawUid === undefined || rawGid === undefined) {
    throw new Error('PORTAL_RUNNER_UID and PORTAL_RUNNER_GID must be configured together.');
  }
  if (platform === 'win32' || portalUid === null) {
    throw new Error('Portal runner UID/GID isolation requires a POSIX process with getuid support.');
  }
  const uid = posixId(rawUid, 'PORTAL_RUNNER_UID');
  const gid = posixId(rawGid, 'PORTAL_RUNNER_GID');
  if (uid === portalUid) throw new Error('PORTAL_RUNNER_UID must differ from the secret-owning portal process UID.');
  return {
    active: true,
    uid,
    gid,
    user: 'pwuser',
    home: '/home/pwuser',
    reason: 'Playwright runs under a separate POSIX identity that cannot read the portal credential vault.',
  };
}

export function resolvePortalAiWorkerIdentity(
  environment = process.env,
  platform = process.platform,
  portalUid = typeof process.getuid === 'function' ? process.getuid() : null,
  runnerIdentity = resolvePortalRunnerIdentity(environment, platform, portalUid),
) {
  const rawUid = environment.PORTAL_AI_WORKER_UID;
  const rawGid = environment.PORTAL_AI_WORKER_GID;
  if (rawUid === undefined && rawGid === undefined) {
    return {
      active: false,
      uid: null,
      gid: null,
      user: null,
      home: null,
      reason: 'A separate AI worker identity is not configured.',
    };
  }
  if (rawUid === undefined || rawGid === undefined) {
    throw new Error('PORTAL_AI_WORKER_UID and PORTAL_AI_WORKER_GID must be configured together.');
  }
  if (platform === 'win32' || portalUid === null) {
    throw new Error('Portal AI worker UID/GID isolation requires a POSIX process with getuid support.');
  }
  if (!runnerIdentity?.active) {
    throw new Error('PORTAL_AI_WORKER_UID/GID requires an active isolated Playwright runner identity.');
  }
  const uid = posixId(rawUid, 'PORTAL_AI_WORKER_UID');
  const gid = posixId(rawGid, 'PORTAL_AI_WORKER_GID');
  if (uid === portalUid) throw new Error('PORTAL_AI_WORKER_UID must differ from the secret-owning portal process UID.');
  if (uid === runnerIdentity.uid) throw new Error('PORTAL_AI_WORKER_UID must differ from the Playwright runner UID.');
  if (gid !== runnerIdentity.gid) {
    throw new Error('PORTAL_AI_WORKER_GID must match the Playwright runner GID so it can read the completed run without sharing its UID.');
  }
  return {
    active: true,
    uid,
    gid,
    user: 'aiworker',
    home: '/home/aiworker',
    reason: 'AI review runs under a third POSIX identity with no credential-vault access.',
  };
}

export function resolvePortalReportWorkerIdentity(
  environment = process.env,
  platform = process.platform,
  portalUid = typeof process.getuid === 'function' ? process.getuid() : null,
  runnerIdentity = resolvePortalRunnerIdentity(environment, platform, portalUid),
  aiWorkerIdentity = resolvePortalAiWorkerIdentity(environment, platform, portalUid, runnerIdentity),
) {
  const rawUid = environment.PORTAL_REPORT_WORKER_UID;
  const rawGid = environment.PORTAL_REPORT_WORKER_GID;
  if (rawUid === undefined && rawGid === undefined) {
    return {
      active: false,
      uid: null,
      gid: null,
      user: null,
      home: null,
      reason: 'A separate report worker identity is not configured.',
    };
  }
  if (rawUid === undefined || rawGid === undefined) {
    throw new Error('PORTAL_REPORT_WORKER_UID and PORTAL_REPORT_WORKER_GID must be configured together.');
  }
  if (platform === 'win32' || portalUid === null) {
    throw new Error('Portal report worker UID/GID isolation requires a POSIX process with getuid support.');
  }
  if (!runnerIdentity?.active || !aiWorkerIdentity?.active) {
    throw new Error('PORTAL_REPORT_WORKER_UID/GID requires isolated Playwright and AI worker identities.');
  }
  const uid = posixId(rawUid, 'PORTAL_REPORT_WORKER_UID');
  const gid = posixId(rawGid, 'PORTAL_REPORT_WORKER_GID');
  if (uid === portalUid) throw new Error('PORTAL_REPORT_WORKER_UID must differ from the secret-owning portal process UID.');
  if (uid === runnerIdentity.uid || uid === aiWorkerIdentity.uid) {
    throw new Error('PORTAL_REPORT_WORKER_UID must differ from both the Playwright and AI worker UIDs.');
  }
  if (gid !== runnerIdentity.gid) {
    throw new Error('PORTAL_REPORT_WORKER_GID must match the run-artifact GID.');
  }
  return {
    active: true,
    uid,
    gid,
    user: 'reportworker',
    home: '/home/reportworker',
    reason: 'Checklist generation runs under a fourth POSIX identity in private staging.',
  };
}

export function sanitizedChildEnvironment(environment = process.env, runnerIdentity = null) {
  const sanitized = { ...environment };
  delete sanitized.ANTHROPIC_API_KEY;
  delete sanitized.PORTAL_SECRET_ROOT;
  delete sanitized.PORTAL_E2E_OPERATOR_TOKEN;
  if (runnerIdentity?.active) {
    sanitized.HOME = runnerIdentity.home;
    sanitized.USER = runnerIdentity.user;
    sanitized.LOGNAME = runnerIdentity.user;
    sanitized.XDG_CACHE_HOME = `${runnerIdentity.home}/.cache`;
  }
  return sanitized;
}

export function runnerSpawnIdentity(identity) {
  return identity?.active ? { uid: identity.uid, gid: identity.gid } : {};
}
