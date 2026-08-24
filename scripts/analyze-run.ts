import path from 'node:path';
import process from 'node:process';
import { deterministicSelfTest, reviewEvidence } from '../ai/evidence-review.js';
import type { AiReviewLimits } from '../ai/types.js';

interface ParsedArguments {
  runDir: string | null;
  outputDir: string | undefined;
  dryRun: boolean;
  selfTest: boolean;
  help: boolean;
  limits: AiReviewLimits;
  request: { deadlineMs: number; maxAttempts: number; maxRetryDelayMs: number };
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}, received ${value}.`);
  }
  return parsed;
}

function parseArguments(argv: string[]): ParsedArguments {
  const args: ParsedArguments = {
    runDir: process.env.AUDIT_ARTIFACT_DIR ?? null,
    outputDir: undefined,
    dryRun: process.env.AI_REVIEW_DRY_RUN === '1',
    selfTest: false,
    help: false,
    limits: {
      maxAudits: integer(process.env.AI_REVIEW_MAX_AUDITS, 25, 1, 100),
      maxScreenshots: integer(process.env.AI_REVIEW_MAX_SCREENSHOTS, 4, 0, 12),
      maxImageBytes: integer(process.env.AI_REVIEW_MAX_IMAGE_BYTES, 2 * 1_024 * 1_024, 1_024, 10 * 1_024 * 1_024),
      maxTotalImageBytes: integer(process.env.AI_REVIEW_MAX_TOTAL_IMAGE_BYTES, 6 * 1_024 * 1_024, 1_024, 24 * 1_024 * 1_024),
    },
    request: {
      deadlineMs: integer(process.env.AI_REVIEW_REQUEST_DEADLINE_MS, 120_000, 1_000, 10 * 60_000),
      maxAttempts: integer(process.env.AI_REVIEW_MAX_ATTEMPTS, 3, 1, 4),
      maxRetryDelayMs: integer(process.env.AI_REVIEW_MAX_RETRY_DELAY_MS, 10_000, 0, 60_000),
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') args.dryRun = true;
    else if (argument === '--self-test') args.selfTest = true;
    else if (argument === '--help' || argument === '-h') args.help = true;
    else if (argument === '--run-dir') args.runDir = argv[++index] ?? null;
    else if (argument === '--output-dir') args.outputDir = argv[++index];
    else if (argument === '--max-audits') args.limits.maxAudits = integer(argv[++index], 25, 1, 100);
    else if (argument === '--max-screenshots') args.limits.maxScreenshots = integer(argv[++index], 4, 0, 12);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return args;
}

function usage(): string {
  return `Usage: tsx scripts/analyze-run.ts --run-dir <artifact-run-directory> [options]

Options:
  --dry-run                 Select and validate evidence without calling Anthropic
  --output-dir <directory>  Override the default <run-dir>/ai-review output
  --max-audits <count>      Bound structured problem audits (default: 25)
  --max-screenshots <count> Bound uploaded screenshots and video posters (default: 4)
  --self-test               Run deterministic parser/redaction/containment checks
  --help                    Show this help

Runtime environment:
  ANTHROPIC_API_KEY          Optional; absent means a safe skipped result
  ANTHROPIC_KEY_STDIN=1      Read the key once from stdin instead of exposing it in the child environment
  ANTHROPIC_MODEL            Defaults to claude-sonnet-5
  AI_REVIEW_DRY_RUN=1        Equivalent to --dry-run
  AI_REVIEW_REQUEST_DEADLINE_MS  Overall API attempt/retry budget (default: 120000)
  AI_REVIEW_MAX_ATTEMPTS      Bounded total API attempts (default: 3)
  AI_REVIEW_MAX_RETRY_DELAY_MS  Maximum Retry-After/backoff delay (default: 10000)

Exit codes: 0 completed/skipped/dry-run; 2 invalid input; 3 API or response failure.`;
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_024) throw new Error('The isolated Anthropic secret-input pipe exceeded its byte limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

let parsed: ParsedArguments;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
  process.exit();
}

if (parsed.help) {
  console.log(usage());
} else if (parsed.selfTest) {
  await deterministicSelfTest();
  console.log('AI evidence-review self-test passed.');
} else if (!parsed.runDir) {
  console.error('A run directory is required. Pass --run-dir or set AUDIT_ARTIFACT_DIR.');
  console.error(usage());
  process.exitCode = 2;
} else {
  try {
    const apiKey = process.env.ANTHROPIC_KEY_STDIN === '1'
      ? await readSecretFromStdin()
      : process.env.ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_KEY_STDIN === '1' && !apiKey) {
      throw new Error('The isolated Anthropic secret-input pipe was empty.');
    }
    const outcome = await reviewEvidence({
      runDir: path.resolve(parsed.runDir),
      ...(parsed.outputDir ? { outputDir: path.resolve(parsed.outputDir) } : {}),
      ...(apiKey ? { apiKey } : {}),
      dryRun: parsed.dryRun,
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
      limits: parsed.limits,
      request: parsed.request,
    });
    console.log(`AI evidence review: ${outcome.document.status}; advisory findings: ${outcome.document.review.findings.length}.`);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
