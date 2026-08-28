import { spawn } from 'node:child_process';
import { MAX_SINGLE_SITE_WORKER_REPLICAS } from './lib/concurrency-defaults.mjs';

const rawReplicas = process.env.SINGLE_SITE_WORKER_REPLICAS ?? '2';
if (!/^[1-9]\d*$/.test(rawReplicas) || Number(rawReplicas) > MAX_SINGLE_SITE_WORKER_REPLICAS) {
  process.stderr.write(`SINGLE_SITE_WORKER_REPLICAS must be an integer from 1 through ${MAX_SINGLE_SITE_WORKER_REPLICAS}.\n`);
  process.exitCode = 2;
} else {
  const args = [
    'compose', 'up', '--build', '--scale', `single-site-worker=${rawReplicas}`,
    'portal', 'single-site-worker', 'single-site-finalizer',
  ];
  process.stdout.write(`${JSON.stringify({
    event: 'portal-stack-starting',
    command: ['docker', ...args],
    singleSiteWorkerReplicas: Number(rawReplicas),
  })}\n`);
  const child = spawn('docker', args, { stdio: 'inherit', shell: false });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    process.stderr.write(`Could not start Docker Compose: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`Docker Compose exited after ${signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
