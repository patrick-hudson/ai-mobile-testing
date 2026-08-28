# AI evidence review

AI review is a second set of eyes over test evidence, not a test oracle.

## Inputs

The analyzer reads the completed run manifest, structured audit results, deterministic failures, browser/runtime/network evidence, a bounded set of representative screenshots, and FFmpeg-generated video posters. It deliberately reserves part of its bounded audit budget for passing visual checks across different audit areas, so it can compare defects against broader successful redesign evidence instead of seeing failures alone. It does not upload full video by default; the original recording remains available for human review.

## Outputs

The analyzer produces machine-readable JSON and a human-readable report containing:

- suspected visual or content defects;
- evidence references and affected audit IDs/projects;
- confidence and an explicit verification suggestion;
- a concise executive summary and prioritized review queue;
- model, request timing, and token-usage metadata.

AI findings are advisory. They cannot change deterministic pass/fail status, supply missing evidence, approve a visual baseline, or complete manual device/screen-reader checks.

## Single-site advisory sequence

Single-site AI is explicit per-run opt-in. In the portal, enable AI for that launch; on the command path, pass `--ai-review <model-id>` to `scripts/run-single-site.mjs`. Deterministic browser execution, required FFmpeg processing, visual comparison, and immutable report/gallery publication finish first. Only then may the supervisor build an AI packet from that exact finalized report revision.

The Single-site packet is mode-aware and contains bounded, allowlisted copies of the deployment URL and confirmed role, `FULL` or `TARGETED` scope, Site Health, Coverage, Evidence Authority, manual state, visual/baseline summary, selected audit details, and eligible screenshots or generated video posters. A sanitized payload inventory is persisted before provider egress. Full video is not uploaded by default.

The only granted capability is `interpret-health-evidence`. Single-site output may identify possible defects, explain deterministic evidence, call out Coverage Gaps, and pose questions for a human reviewer. It cannot recommend release, promotion, deployment, rollback, baseline approval/revocation, a Finding waiver, a visual disposition, manual attestation, credential mutation, stop, or purge. Prohibited fields fail validation rather than being ignored.

AI state is separate from the finalized audit: `pending`, `running`, `completed`, `failed`, or `unavailable`. Provider failure or timeout leaves deterministic finalization complete and Site Health unchanged. A pending or running attempt interrupted by portal restart becomes unavailable and retryable after a credential is available; the secret is never stored with the run. A Single-site AI failure remains non-gating and the analyzer exits successfully for that advisory failure, while invalid local input remains an error.

To exercise selection, redaction, and output shape without provider egress, start the stack with:

```sh
AI_REVIEW_DRY_RUN=1 npm run portal
```

For direct analyzer development, Single-site egress also requires `--opt-in` (or `AI_REVIEW_OPT_IN=1`):

```sh
npm run ai:review -- --run-dir <finalized-run-directory> --opt-in
```

The normal operational path is the portal or `scripts/run-single-site.mjs`; both preserve the durable advisory state and bind the request to the finalized report publication.

## Secrets and logs

- Accept a key only from the process environment or the dedicated same-origin portal credential endpoint.
- Encrypt portal-saved keys with AES-256-GCM in the persistent Docker secret volume; never use browser storage.
- Return only configured state and a short SHA-256 fingerprint—never echo the credential.
- Never write a key to manifests, reports, run artifacts, logs, Compose files, images, or build arguments.
- Redact secret-shaped values from all child-process output before persistence or SSE broadcast.
- Log the model, endpoint status, latency, usage, evidence filenames/types/sizes, and stage outcome—not authorization headers or base64/image bodies.
- A missing key cleanly skips the optional stage and records why.

The recommended credential path is the portal's Claude settings. The root supervisor encrypts the key with AES-256-GCM in the Compose-project-scoped `portal-secrets` volume and returns only configured state and a short fingerprint. Compose deliberately does not forward `ANTHROPIC_API_KEY`; an environment-injected key is an advanced deployment option whose container configuration must be treated as secret-bearing. The supervisor sends the selected key once to isolated `aiworker` over stdin, while Playwright, FFmpeg, report workers, and run artifacts cannot read the vault.

The implementation uses Anthropic's Messages API and image content blocks according to the official [Messages examples](https://docs.anthropic.com/en/api/messages-examples) and [vision guide](https://docs.anthropic.com/en/docs/build-with-claude/vision). These calls consume separately billed Anthropic API credits; [Claude.ai paid-plan usage does not cover API calls](https://support.anthropic.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console). The default model can be overridden with `ANTHROPIC_MODEL` so deployments can pin an approved model.
