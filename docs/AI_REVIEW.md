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

## Secrets and logs

- Accept a key only from the process environment or the dedicated same-origin portal credential endpoint.
- Encrypt portal-saved keys with AES-256-GCM in the persistent Docker secret volume; never use browser storage.
- Return only configured state and a short SHA-256 fingerprint—never echo the credential.
- Never write a key to manifests, reports, run artifacts, logs, Compose files, images, or build arguments.
- Redact secret-shaped values from all child-process output before persistence or SSE broadcast.
- Log the model, endpoint status, latency, usage, evidence filenames/types/sizes, and stage outcome—not authorization headers or base64/image bodies.
- A missing key cleanly skips the optional stage and records why.

The implementation uses Anthropic's Messages API and image content blocks according to the official [Messages examples](https://docs.anthropic.com/en/api/messages-examples) and [vision guide](https://docs.anthropic.com/en/docs/build-with-claude/vision). The default model can be overridden with `ANTHROPIC_MODEL` so deployments can pin an approved model.
