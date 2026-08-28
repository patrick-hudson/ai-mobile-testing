import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';

const usage = 'Usage: npm run single-site:probe -- <origin> [preview|production] [strict|preview-bypass]\n';
const url = process.argv[2] ?? process.env.AUDIT_SINGLE_SITE_URL;
const deploymentRole = process.argv[3] ?? process.env.AUDIT_SINGLE_SITE_ROLE ?? 'preview';
const certificatePolicy = process.argv[4]
  ?? process.env.AUDIT_SINGLE_SITE_CERTIFICATE_POLICY
  ?? 'strict';

if (url === '--help' || url === '-h') {
  process.stdout.write(usage);
} else if (!url) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  const previewBypassOrigins = String(process.env.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  process.stdout.write(`Single-site preflight: origin=${url} role=${deploymentRole} certificatePolicy=${certificatePolicy}\n`);
  const result = await preflightQuitting7ohSite({ url, deploymentRole, certificatePolicy }, {
    previewBypassOrigins,
    tlsBypassRequestOptions: { rejectUnauthorized: false },
  });
  for (const probe of result.probes) {
    process.stdout.write(
      `HTTP probe: id=${probe.id} requested=${probe.requestedUrl} final=${probe.finalUrl ?? 'none'} `
      + `status=${probe.statusCode ?? 'none'} contentType=${probe.contentType ?? 'none'} hops=${probe.hops.length}\n`,
    );
    for (const hop of probe.hops) {
      process.stdout.write(
        `  hop: ${hop.statusCode} ${hop.url} resolved=${hop.resolvedAddresses.join(',')} `
        + `connected=${hop.connectedAddress}${hop.location ? ` location=${hop.location}` : ''}\n`,
      );
    }
  }
  for (const marker of result.markers) {
    process.stdout.write(
      `Identity marker: ${marker.id} probe=${marker.probe} result=${marker.passed ? 'matched' : 'MISMATCH'} `
      + `expected=${JSON.stringify(marker.expected)} observed=${JSON.stringify(marker.observed)}\n`,
    );
  }
  for (const issue of result.issues) {
    process.stderr.write(`Preflight issue: ${issue.code} focus=${issue.focusTarget} ${issue.message}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    accepted: result.accepted,
    origin: result.origin,
    deploymentRole: result.deploymentRole,
    evidenceAuthority: result.evidenceAuthority,
    identityFingerprint: result.identityFingerprint,
    deploymentRevision: result.deploymentRevision,
    preflightDigest: result.preflightDigest,
  }, null, 2)}\n`);
  if (!result.accepted) process.exitCode = 2;
}
