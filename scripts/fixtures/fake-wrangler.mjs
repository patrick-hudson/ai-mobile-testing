import { writeFile } from 'node:fs/promises';

if (process.argv.includes('--version')) {
  process.stdout.write('4.127.1\n');
} else {
  await writeFile(process.env.FAKE_WRANGLER_INVOCATION, JSON.stringify({
    argv: process.argv.slice(2),
    hasToken: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  }));
  process.stdout.write('Deployment complete: https://production-deployment-123.quitting7oh-org.pages.dev\n');
}
