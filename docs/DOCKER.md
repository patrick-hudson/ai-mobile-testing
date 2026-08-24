# Docker execution and audit portal

The Docker image is the canonical way to run this suite. It pins the Playwright browser image to the same Playwright release used by the project, contains all three browser engines, and writes every result to the host-mounted `artifacts/` directory.

## Start the portal

```sh
docker compose up --build portal
```

Open <http://localhost:4173>. The port is bound to localhost by default so the process-launching interface is not exposed to the network.

The portal lets a reviewer:

- choose smoke or full release evidence;
- change the production and candidate origins for a run;
- choose the exact Playwright browser/device projects;
- run the whole profile or target validated installed test suites, documented audit areas, and IDs;
- follow Playwright output and test progress live;
- stop an active run;
- permanently purge a completed, failed, or stopped run after typing its exact confirmation;
- open a separate non-technical report for every run, with its release decision, scope, coverage, findings, and manual/AI review state;
- browse the complete Long Build Checklist in filtered 25-row pages and expand one audit at a time for observations, response-code summaries, videos, posters, screenshots, and source links; and
- open a run-wide Visual Gallery immediately, review a test queue or virtualized overview, apply revision updates explicitly, flag defects, and inspect bounded gallery activity, execution logs, and advanced raw files; and
- reopen Playwright reports, screenshots, traces, JSON evidence, and videos.

Run selection, detail loading, artifact enumeration, manual evidence, credential settings, start, and stop operations are asynchronous. Accessible busy states and progress announcements remain visible until each request resolves, and duplicate mutations are disabled while pending. Evidence files are incrementally indexed and server-paged, so a full 1,407-test artifact tree does not force the browser to scan or render tens of thousands of links at once.

The reviewer report is the browser-safe Long Build Checklist. Report generation writes compact summary, audit-index, and bounded per-audit detail documents into `checklist/data/revisions/<revision>/`, hashes every document in that revision's publication manifest, and makes the set authoritative only with the final atomic `checklist/data/current.json` rename. The report page pins filtered and detail requests to the exact revision returned with its summary; external terminal runs fail evidence integrity if any declared document is missing, substituted, or from another generation. Compatibility mirrors remain at `checklist/data/summary.json`, `checklist/data/audits.json`, and `checklist/data/audits/`, but they are not release-authoritative. The portal enforces 256 KiB, 2 MiB, and 512 KiB limits for the three layers, filters and paginates audits on the server, aborts superseded browser requests, and keeps the DOM bounded to one 25-row page and one audit detail. The 59 MB-class `checklist/manifest.json` is never fetched by the report page; it is offered only as an explicitly large download. Likewise, the recent-log panel is opt-in and capped at 64 KiB while complete persisted log files remain direct evidence downloads.

The general run console also stays bounded: its log endpoint defaults to a 256 KiB UTF-8-safe tail with a hard 1 MiB ceiling and reports each source file's complete size and truncation state. SSE replay is capped at 512 KiB, slow clients receive an overflow notice instead of accumulating an unbounded queue, and the browser batches incoming lines before one DOM update. Large media and traces stream with `Content-Length`, `Accept-Ranges`, and HTTP 206 support instead of being buffered in memory.

Known external-run reads use stale-while-revalidate behavior: the portal returns its last safe snapshot immediately and schedules filesystem refresh work asynchronously. Each refresh has one global 2 MiB read budget and 250 ms time budget across lifecycle, heartbeat, and incremental log ingestion; remaining work waits for a later refresh instead of blocking a browser request. After a portal restart, exact active-test progress is restored from `sharded-heartbeat.json`. Persisted logs remain the verbose evidence trail, but restart recovery uses bounded tail/incremental reads and never scans an unbounded log prefix to reconstruct counters.

Evidence labels reflect the capture policy instead of implying every check has a video. Action-to-response interactions may show a playable video and FFmpeg poster with their recorded rationale. Static visual verification uses screenshots. Each audit displays the actual video and screenshot counts available for that run.

Every launch receives an isolated directory at `artifacts/runs/<run-id>/`. Its `run.json` records the targets, selection, browser projects, safe command arguments, progress, timestamps, and exit result. `logs/runner.log` preserves the complete timestamped process output. The test reporters write their evidence into the same run directory through `AUDIT_ARTIFACT_DIR`.

Portal status has three independent parts. `pipeline.status` says whether browser execution and required evidence processing completed. `release.decision` preserves the checklist result. `executionProvenance` and `reviewReasons` say whether that result is eligible for final signoff. A portal-launched release always records `portal-single-container` / `review-evidence-only` provenance, so even a `READY` checklist becomes `review-required`; final authority comes only from a new-ID sharded run with the isolated performance container. TLS bypass, flaky checks, smoke, and reduced scope also withhold signoff. The browser process exit code remains visible as diagnostic data, but it cannot overrule the checklist or provenance.

After Playwright exits—whether its checks pass or fail—the portal runs a visible evidence pipeline: video hashing/poster indexing, optional AI evidence review, then a final checklist rebuild. That rebuild discovers each FFmpeg-generated sibling `*-poster.jpg`, copies it into the checklist evidence directory, records its size and checksum, uses it as the video preview, and exposes a separate poster link. Videos without a generated poster remain playable and linked exactly as before. Each command has a persisted lifecycle record with start/end time, duration, exit status, and live stage-prefixed output. A required video/report failure produces the distinct non-green `evidence-failed` result. AI remains advisory and cannot turn a failed deterministic audit green.

The portal does not accept commands or test paths. It starts the local Playwright executable directly—without a shell—and only after checking projects, profiles, audit areas, and audit IDs against allowlists loaded from the repository. Target URLs must be plain HTTP(S) origins without credentials, paths, query strings, or fragments. Only one run is allowed at a time by default; a synchronous reservation closes concurrent-launch races before filesystem work begins. Runner and lifecycle append streams must report that they opened before registration/spawn proceeds, and retain error handlers afterward; stream, persistence, or spawn-setup failure becomes a terminal failure without holding capacity. Manual rebuild streams use the same open/error contract. Every request first crosses a loopback/explicit Host allowlist, and every mutation also enforces same-origin browser metadata. This blocks DNS-rebinding requests even when an attacker supplies an Origin matching their forged Host. `PORTAL_ALLOWED_HOSTS` may add an intentional local hostname; do not expose the portal as a shared unauthenticated service.

Manual uploads are serialized with attestations and checklist rebuilds per run, so concurrent requests return `409` instead of overwriting `manual-evidence.json`. PNG, JPEG, WebM, and MP4 declarations are checked against their byte signatures, probed for a visual stream and valid dimensions, and decoded through the first frame under a bounded timeout before the file is renamed or can support a passing attestation. Invalid and interrupted temporary/final files are removed. Artifact responses open the contained final file with no-follow semantics before headers, stream from that descriptor with range support, and handle disappear/stream errors without crashing the portal.

Installed test suites come only from the generated, validated `audit/plugins.generated.json` registry. Selecting a suite merges and deduplicates its allowlisted spec paths, constrains the selected browser projects to the plugin's supported-project list, and builds an escaped audit-ID grep from that suite's definitions. A shared spec can therefore serve several suites without accidentally executing its sibling checks. The portal never accepts a spec path from the browser.

### Optional AI evidence review

AI review is opt-in for each portal run. Open Claude settings in the portal to save, replace, or delete the credential. The server encrypts saved credentials with AES-256-GCM in the Compose-project-scoped `portal-secrets` Docker volume mounted at `/var/lib/ai-mobile-testing/secrets`, outside `/work` and Playwright's test-discovery tree. The browser receives only configured state and a short one-way fingerprint. It never stores the key locally or sends it in a run request.

Compose deliberately does not forward `ANTHROPIC_API_KEY`: container environment/configuration is inspectable and frequently captured in diagnostics. Save the key in the portal instead. A separately managed deployment may still inject an environment key directly into the supervisor, but operators must treat its container configuration as secret-bearing.

The root portal supervisor owns the mode-0700 vault. Playwright and video processing run as the image's non-root `pwuser`; AI review runs as non-root `aiworker`; and checklist generation runs as a distinct non-root `reportworker`. Every worker environment removes the vault path and every key source. `aiworker` shares only the completed run-artifact group and cannot read the vault or inspect browser processes as the same UID. The supervisor sends the selected key once over an anonymous stdin pipe, so it does not appear in the AI worker environment. Before any request, the AI worker freezes bounded regular evidence files through contained canonical paths, rejects every symbolic-link component, and opens the final file with no-follow semantics. After browser, media, and AI work, the supervisor removes symlinks, rejects hard links and non-regular artifacts, makes the run tree read-only to worker identities, gives `reportworker` one private staging directory, and atomically publishes the completed checklist. Credential settings and AI launch are disabled unless all three worker identities are established. A portal-saved key is accepted only by the dedicated same-origin credential endpoint and is never echoed. No key reaches a run manifest, event stream, log, command summary, report, or artifact. The default model is `claude-sonnet-5`; override it with `ANTHROPIC_MODEL` at container startup or in the validated model field for one launch. `AI_REVIEW_DRY_RUN=1` exercises the stage and output contract without an API request.

The review appears under `ai-review/` as `review.json`, `index.html`, `review.md`, and a provider-safe lifecycle log. The portal displays only allowlisted telemetry: model, response status, latency, and token usage. It does not display request/response bodies or headers.

## Run without the portal

Run the quick paired audit:

```sh
docker compose --profile audit run --rm audit-smoke
```

Run the complete release suite. Executed interaction/action-response scenarios retain purposeful video; static visual checks retain screenshots, and request/data contracts retain structured evidence without decorative recordings:

```sh
docker compose --profile audit run --rm audit-release
```

Run the portal's own isolated browser/API acceptance suite:

```sh
npm run portal:e2e
```

That command starts a temporary portal inside the Playwright image, drives it with Chromium, executes a small real candidate audit through the portal, checks live logs and fail-closed release truth, exercises hostile Host/origin requests and concurrent launch/manual mutations, rejects fake media, verifies contained descriptor/range artifact serving and purge stream closure, tests the credential UI with a synthetic key, and removes its temporary secret/run storage afterward. Before every invocation, the runner safely clears only the exact `artifacts/portal-e2e/` directory and starts a truncated server log, so interrupted or failed evidence cannot be mistaken for a prior green run. `portal-e2e-run.json` records the current invocation as running, passed, or failed. Its Playwright report and server log remain under that directory.

Run the canonical large-gallery profile independently while iterating:

```sh
npm run portal:e2e:scale
```

The `portal-e2e` service is constrained to 2 CPUs and 4 GiB. The runner verifies the actual cgroup values before collecting 5 cold warmups + 30 cold measurements and 10 warmup + 100 measured item transitions. The fixture physically materializes and recounts all 17,527 corpus files: every one of the 5,659 artifact hrefs plus 11,868 modeled storage copies. It does not infer this footprint from metadata. `artifacts/portal-e2e/gallery-scale-metrics.json` retains every sample, the materialized counts, and the DOM/media/heap/stale-work maxima; `gallery-scale-network.har.zip`, `gallery-scale-workbench.png`, `gallery-scale-overview.png`, `gallery-scale-archive-read-only.png`, and `gallery-scale-navigation.webm` are the review evidence. The video is justified because it records keyboard, filter, touch, comparison, fullscreen, and video-control interactions; static layout evidence remains screenshots.

The scale gate requires p95 first usable at or below 2 seconds, p95 item change at or below 200 ms, no more than three cold metadata requests / 1 MiB, no more than 500 gallery DOM nodes, one selected video, no adjacent videos, no stale commit after 50 superseding changes, and no more than 25 MiB heap growth after 100 measured traversals. Both CDP heap samples must exist, be finite, and be positive; an unavailable metric is a failure. The video bound is taken from the observed selected-video DOM after the real playback/range journey, never a fabricated minimum. Archive query wrappers remain 256 KiB/100 rows, item details remain 512 KiB, and the direct-file first view loads only its intersecting published-order chunk plus selected detail and flags.

### Browser and device target matrix

The default release scope remains exactly the established seven projects. Adding target definitions does not silently multiply a normal or sharded run:

| Default project ID | Runtime | Evidence fidelity |
| --- | --- | --- |
| `production-mobile-chromium` | Chromium with Pixel 5 descriptor | Android 11 user-agent, viewport, touch, and scale emulation; not a physical Pixel or Chrome for Android |
| `candidate-mobile-chromium` | Chromium with Pixel 5 descriptor | Android 11 user-agent, viewport, touch, and scale emulation; not a physical Pixel or Chrome for Android |
| `production-desktop-chromium` | Playwright Chromium | Docker-local desktop browser |
| `candidate-desktop-chromium` | Playwright Chromium | Docker-local desktop browser |
| `candidate-mobile-webkit` | WebKit with iPhone 13 descriptor | iOS 15 user-agent/device emulation; not iOS or Mobile Safari |
| `candidate-tablet-webkit` | WebKit with iPad Mini descriptor | iPad descriptor emulation; not iPadOS or Mobile Safari |
| `candidate-desktop-firefox` | Playwright Firefox | Docker-local desktop browser |

Set `AUDIT_TARGET_IDS` to an exact comma-separated selection to opt into another Docker-local profile. When set, it replaces the defaults for that browser process; list every project needed for the run. Unknown IDs, duplicates, metadata-only provider IDs, and unavailable browser capabilities stop configuration before a browser launches.

| Opt-in project ID | What actually runs |
| --- | --- |
| `candidate-mobile-webkit-iphone-17-ios18` | Playwright WebKit with iPhone 17 viewport/input and iOS 18.7 user agent |
| `candidate-mobile-webkit-iphone-15-ios17` | Playwright WebKit with iPhone 15 viewport/input and iOS 17.5 user agent |
| `candidate-mobile-chromium-pixel-10-android16` | Playwright Chromium with Pixel 10 viewport/input and Android 16 user agent |
| `candidate-mobile-chromium-pixel-8-android14` | Playwright Chromium with Pixel 8 viewport/input and Android 14 user agent |
| `candidate-mobile-chromium-galaxy-s24-android14` | Playwright Chromium with Galaxy S24 viewport/input and Android 14 user agent |
| `candidate-desktop-chromium-edge-compat` | Playwright Chromium with the Edge desktop user agent/viewport; explicitly not the branded Edge binary |
| `candidate-desktop-chromium-msedge` | Branded Microsoft Edge channel; requires the optional image capability below |

For example, run current/recent mobile emulations together:

```sh
AUDIT_TARGET_IDS=candidate-mobile-webkit-iphone-17-ios18,candidate-mobile-webkit-iphone-15-ios17,candidate-mobile-chromium-pixel-10-android16,candidate-mobile-chromium-galaxy-s24-android14 \
docker compose --profile audit run --rm audit-release
```

Branded Edge is deliberately a separate capability from Edge-compatible Chromium. It adds image size and a vendor download, so the default image does not install it:

```sh
INSTALL_MSEDGE=1 docker compose --profile audit build audit-release
AUDIT_TARGET_IDS=candidate-desktop-chromium-msedge \
docker compose --profile audit run --rm audit-release
```

The image records `AUDIT_MSEDGE_AVAILABLE=1`, and configuration also verifies the executable. Setting that runtime flag by hand without the binary still fails. Use `candidate-desktop-chromium-edge-compat` when user-agent/layout compatibility is sufficient; never label that evidence Microsoft Edge.

The registry also publishes non-runnable provider metadata for current/previous real iOS Safari and Android Chrome. Those IDs are rejected by `AUDIT_TARGET_IDS`. A future BrowserStack, Sauce, or device-lab adapter must provide a real session, credentials, artifact transfer, and evidence provenance before a provider row can become executable. Until then, physical-device checklist rows remain manual and cannot be satisfied by Playwright emulation.

Run `npm run targets:validate` after extending `audit/targets.ts`; it refreshes the checked-in browser-safe projection, `audit/targets.generated.json`. `npm run targets:check` rejects drift, and `npm run targets:self-test` validates unique IDs, the unchanged default order, shipped Playwright descriptors, emulation labels, provider non-runnability, and fail-closed capabilities.

### Parallel functional shards with isolated performance audit

The recommended full release command divides the functional and visual project/test matrix across eight shard partitions. A bounded pool runs four single-worker Docker containers at once by default, starting the next partition as each container finishes. After all functional shards stop consuming CPU and memory, it starts `tests/performance.spec.ts` in a separate Docker container with exactly one Playwright worker. Only then does it start the merge container for the authoritative reports and evidence gates:

```sh
npm run audit:release:sharded
```

The host coordinator only requires Node and Docker Compose. It first builds the current pinned image, then keeps all Playwright, browser, Lighthouse, merge, and evidence work inside that image. The default is eight functional shards with one Playwright worker in each shard and at most four shard containers active simultaneously. Finer partitions reduce idle-container tail time, while the separate concurrency limit prevents Docker Desktop memory pressure from crashing browsers. Partition count, pool size, and workers remain bounded and configurable; the performance container is intentionally fixed at one worker so scores are not depressed by browser-shard resource contention:

```sh
AUDIT_SHARD_TOTAL=8 \
AUDIT_SHARD_CONCURRENCY=4 \
AUDIT_SHARD_WORKERS=1 \
AUDIT_SHARDED_RUN_ID=release-candidate-2026-08-24 \
npm run audit:release:sharded
```

`AUDIT_SHARDED_RUN_ID` must be a new 8–80 character lowercase name made from letters, numbers, and hyphens. The coordinator atomically reserves `artifacts/sharded/<run-id>/` before it writes a log or starts Docker. If that directory already exists, the run stops without modifying it. This prevents a rerun from inheriting an older lifecycle file, manual approval, report, or media artifact. Choose a new ID for every evidence run; archive or purge the old directory separately instead of reusing its name.

Each functional shard runs `playwright test --shard=N/T --reporter=blob` with `tests/performance.spec.ts` excluded. The isolated container then runs `playwright test tests/performance.spec.ts --workers=1 --reporter=blob`. Every container writes distinct raw evidence and a blob archive. The merge preflight requires all `T` functional blobs plus the isolated performance blob to exist, be non-empty, and be newer than the coordinator start time. Missing or stale evidence fails the pipeline and prevents stale structured results from being presented as authoritative. With a clean preflight, the merge container runs these stages in order:

```text
playwright merge-reports --config=playwright.merge.config.ts <blob-directory>
tsx scripts/process-videos.ts --run-dir <merged-run-directory>
tsx scripts/rebuild-report.ts <results.json> <checklist-directory>
```

Output is stored beneath `artifacts/sharded/<run-id>/`:

```text
blob-reports/                 Playwright blob from every shard
shards/shard-N-of-T/raw/      Original videos, traces, and screenshots
shards/performance-isolated/  Uncontended browser and Lighthouse evidence
logs/coordinator.log          Overall lifecycle and exact Docker commands
logs/build.log                Portable image build output
logs/shard-N-of-T.log         Timestamped, shard-prefixed output
logs/performance.log          Dedicated one-worker performance output
logs/merge.log                Merge and evidence-stage output
results.json                  One merged machine-readable result
playwright-html/              One merged Playwright report
checklist/                    One merged Long Build Checklist
video-manifest.json           Video hashes, poster status, and processing result
merge-lifecycle.json          Merge/evidence command timing and exit codes
pipeline-diagnostics.json     Bounded coordinator/media integrity input; never release authority
sharded-run.json              Overall shard and final release result
```

`video-manifest.json` also records the results-driven retention decision: eligible interaction attempts, skipped or policy-rejected attempts, pruned files and bytes, and any integrity errors. The media stage applies the same evidence contract in every profile: every executed interaction check requires a usable action-and-response video, including a passing interaction selected by a smoke run. Smoke can select fewer checks, but it does not weaken evidence semantics for the interactions it executes. This same stage runs for portal-launched and sharded releases; it preserves failed interaction clips and never removes reviewer-supplied files under `manual-evidence/`.

Eligible clips receive a lightweight FFmpeg quality probe before poster generation. The manifest records duration, sampled-frame count, luma range, maximum frame change, changes measured after sustained page content, initial/final content ratios, leading blank duration, usability, diagnostic-only retention, normalization details, and rejection reasons for each attachment. Clips that cannot decode at least two representative frames, have only low-information solid frames, or lack measurable frame-to-frame visual change are treated as helper/non-action media. The solid-frame check uses sampled luma spread instead of a fixed brightness threshold, so studio-range and full-range white, black, gray, and tinted blanks are rejected consistently. A leading blank browser-capture prefix may be trimmed into a new content-hashed derivative only when the original stays below the overall blank limit, ends with sustained content, and contains a later visible transition after the first page state settles. The derivative is then decoded and evaluated against the complete gate again. A delayed first paint alone therefore cannot become interaction evidence; entirely blank, mostly blank, and blank-ending clips remain rejected. Clips shorter than two seconds also fail release evidence integrity. A short failed or timed-out clip that does decode and visibly changes is retained only as diagnostic evidence; it cannot satisfy the action-video gate. Short blank/static helpers and other rejected clips are removed from normalized `results.json`, and their raw, blob-resource, HTML-data, checklist, and poster duplicates are pruned. A real interaction clip in the same test attempt remains linked and reviewable.

The coordinator always attempts isolated performance collection after the functional shards and then attempts the merge/evidence pipeline. It records pipeline completion separately from release readiness, reads the final decision from `checklist/manifest.json`, and exits nonzero for either a failed pipeline or `NOT_READY`. The portal independently derives external terminal truth: `pipeline.status` must be `completed`, `pipeline.completed` must be true, the complete release object must pass the same decision/ready/reason/blocker/integrity validation as a checklist manifest, and the declared lifecycle status must match the normalized decision. A malformed `ready` lifecycle cannot override an incomplete pipeline, `NOT_READY`, `ready: false`, blockers, or an integrity failure; the portal marks the run `evidence-failed` and retains every reported field in lifecycle diagnostics. Playwright exit code 1 remains diagnostic when fresh, valid evidence proves ordinary product findings. A shard deadline, signal, abnormal process exit, or required media-stage failure is a run-integrity failure even if partial merged JSON exists: the generated checklist is marked `UNAVAILABLE`, keeps its audit counts for diagnosis only, and identifies `sharded-run.json` as authoritative. A missing or stale functional/performance blob, stale or missing merged result, failed media/rebuild stage, missing checklist, or contradictory release fields is always a pipeline failure and cannot be hidden by a later stage.

Use the coordinator command rather than invoking `audit-release-merge` directly. The coordinator injects the exact run-start timestamp used by the freshness gate; a direct merge without that timestamp fails closed.

Keep the portal running while launching this command from another terminal. It watches `artifacts/sharded/` every second and discovers a run as soon as `logs/coordinator.log` appears—before `sharded-run.json` exists. The run detail view follows the Docker build, every functional shard, the aggregate shard stage, the isolated one-worker performance stage, merge preflight, FFmpeg processing, and checklist rebuild; new log lines stream through the same live console used by portal-managed runs. Known-run requests stay responsive through cached snapshots and asynchronous bounded refreshes, and a portal restart restores exact coordinator progress from the heartbeat sidecar before incremental logs catch up. Once `sharded-run.json` is written, the authoritative pipeline and release fields replace inferred state and the completed run remains visible after portal/container restarts. External execution is read-only in the portal: stop active work from the terminal that launched the coordinator. After it reaches a terminal state, its complete sharded evidence directory may be purged from the portal with the same typed confirmation used for portal-managed runs.

Candidate TLS remains strict by default (`CANDIDATE_IGNORE_HTTPS_ERRORS=0`), production is always strict, and the image-baked/development CA flow is unchanged. If the explicit candidate-only development bypass is used, its value is recorded in `sharded-run.json` and printed in the coordinator/shard logs.

### Memory-constrained hosts and container boundaries

The default sharded release keeps at most four of its eight single-worker functional shard containers active at once, followed by one isolated single-worker performance container. On a memory-constrained Docker host, reduce `AUDIT_SHARD_CONCURRENCY` before changing the eight-part coverage partition. The performance step remains isolated regardless of the functional settings. A single-container, non-sharded release with one worker executes the same release profile more slowly:

```sh
AUDIT_WORKERS=1 docker compose --profile audit run --rm audit-release
```

For a lower-peak parallel run, keep eight partitions but run only two at once:

```sh
AUDIT_SHARD_TOTAL=8 AUDIT_SHARD_CONCURRENCY=2 AUDIT_SHARD_WORKERS=1 npm run audit:release:sharded
```

Each running audit container has a 1 GB shared-memory area and its browser processes use additional host memory. More shards and workers primarily trade memory for elapsed time; they do not add audit coverage. Keep `PORTAL_MAX_CONCURRENT_RUNS=1` and `AUDIT_WORKERS=1` when launching from the portal on a constrained machine.

Horizontal portal replicas are not supported. The portal queue, live run registry, and in-flight credential are process-local, while `artifacts/` and the named credential volume are shared storage. Scaling the portal can therefore bypass its concurrency limit and give different replicas incomplete live state. The supported multi-container topology is the shard coordinator above: each audit shard writes a distinct directory, and exactly one merge container creates the authoritative reports after every shard exits.

The Compose-project-scoped `portal-secrets` volume is a single-deployment trust boundary: it contains both the encrypted credential envelope and its file-protected master key. Compose project names produce independent volumes by default; do not deliberately attach one project's volume to another deployment. Host administrators or any container granted access to that volume must be treated as able to recover the credential. Use a distinct Compose project name, artifact root, and host port for an intentionally independent portal deployment.

Choose other origins or reduce parallelism without rebuilding:

```sh
PRODUCTION_URL=https://quitting7oh.org \
CANDIDATE_URL=https://beta.quitting7oh-org.pages.dev \
AUDIT_WORKERS=2 \
AUDIT_ARTIFACT_DIR=/work/artifacts/my-release \
docker compose --profile audit run --rm audit-release
```

`AUDIT_ARTIFACT_DIR` is a container path and must stay beneath `/work/artifacts` if the output should appear on the host.

## Image version contract

The default build uses `mcr.microsoft.com/playwright:v1.62.1-noble`. The Playwright package and image must remain on the exact same version because browser binaries are revision-specific. When upgrading the dependency, update the default `PLAYWRIGHT_VERSION` in both `Dockerfile` and `docker-compose.yml` in the same change.

To verify another image version before making it the default:

```sh
PLAYWRIGHT_VERSION=1.62.1 docker compose build --pull portal
```

## TLS trust and development bypass

The image bakes in this team's public Netskope root CA from `certs/development-ca.crt`, updates the Linux trust store, and exposes it to Node through `NODE_EXTRA_CA_CERTS`. Startup logs confirm the active trust source. This keeps Chromium, Firefox, WebKit, curl, Node requests, and Lighthouse strict while working inside the inspected network.

`CANDIDATE_IGNORE_HTTPS_ERRORS` accepts only `0` or `1` and defaults to `0`. The portal exposes the same policy as an explicit candidate-only checkbox. Playwright configuration fails before browser launch if a portal, direct Compose, or sharded command requests the bypass for the configured production hostname or a protected Quitting7OH production hostname. An allowed development bypass is recorded in `run.json` and live logs and changes otherwise-passing candidate executions to `REVIEW`; it cannot produce a release-ready checklist. CI explicitly forces `0` and runs the negative TLS policy checks inside the built image.

## Durable evidence and permissions

`./artifacts` is bind-mounted to `/work/artifacts`. Back up release-candidate run directories to durable object storage; CI artifacts are useful for review but are not permanent archives. Keep the run manifest with its reports and videos so the evidence retains its target URLs and execution context.

To reclaim local storage, open a terminal-state run in the portal, choose **Purge run and evidence**, and type the displayed `PURGE <run-id>` phrase exactly. The operation asynchronously counts and removes that run's complete directory, then reports files and bytes reclaimed. It is intentionally unavailable while a run is starting, running, stopping, or rebuilding manual evidence. The server resolves the selected run to one exact direct child of `PORTAL_ARTIFACT_ROOT` or `PORTAL_SHARDED_ARTIFACT_ROOT`, rejects broad roots and symlinked run directories, and never follows a browser-supplied filesystem path. Purging is irreversible and is not an archive workflow.

Direct smoke/release services use the official Playwright image's root execution model and are intended only for the two trusted project origins. Portal launches use a stricter four-identity split: the root supervisor owns the credential vault and lifecycle state; Playwright and FFmpeg run as `pwuser`; advisory AI review runs as `aiworker` with one-shot stdin secret delivery; and checklist generation runs as `reportworker` against a frozen source tree and private staging directory. All workers receive sanitized environments and none can read the vault. Do not point this suite at arbitrary untrusted sites. A deployment designed for hostile origins also needs Playwright's recommended seccomp profile and a separately reviewed container boundary.

## Continuous integration

`docker-smoke.yml` builds the exact image and runs the smoke suite on pull requests, pushes to `main`, and manual dispatch. It uploads the complete smoke evidence even when tests fail. Because smoke intentionally leaves most release gates unexecuted, its checklist normally says `NOT_READY`; that result describes release scope rather than a broken evidence pipeline. The smoke workflow therefore uses an explicit pipeline-only gate: it requires a valid authoritative checklist, zero failures among the executed blocking checks, and no run-integrity failure, while retaining and reporting `NOT_READY` rather than implying the candidate is release-ready.

`release-audit.yml` is manual by design. It accepts the two target origins and worker count, runs the full suite inside Docker, and retains the release evidence for 90 days. Evidence uploads run regardless of outcome, then CI enforces the authoritative checklist decision together with the recorded pipeline status. Only a completed pipeline with `release.decision: READY` is green.

## Operational controls

These optional variables affect the portal container:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORTAL_PORT` | `4173` | Host port mapped to the portal. |
| `PORTAL_MAX_CONCURRENT_RUNS` | `1` | Concurrent launches, capped by the server at four. |
| `PORTAL_SHARDED_ARTIFACT_ROOT` | `/work/artifacts/sharded` | Discovery/evidence root for terminal-launched releases; active execution stays read-only, terminal evidence may be purged with confirmation. |
| `PORTAL_ALLOWED_HOSTS` | unset | Optional comma-separated extra local hostnames accepted by the request Host guard; loopback names are always allowed. |
| `PORTAL_EXTERNAL_RUN_SYNC_MS` | `1000` | External-run log and lifecycle refresh interval; allowed range 250–30000 ms. |
| `PORTAL_EXTERNAL_TERMINAL_REFRESH_MS` | `30000` | Recheck interval for terminal external lifecycle evidence; allowed range 1000–600000 ms. |
| `PORTAL_EXTERNAL_REFRESH_BYTES` | `2097152` | Global bytes available to one asynchronous external-run refresh; allowed range 512 KiB–64 MiB. |
| `PORTAL_EXTERNAL_REFRESH_MS` | `250` | Global wall-time budget for one external-run refresh; allowed range 50–5000 ms. |
| `AUDIT_WORKERS` | `3` | Playwright worker processes per run. |
| `AUDIT_TARGET_IDS` | seven default projects | Exact comma-separated Docker-local target selection; unknown, duplicate, provider-only, or unavailable IDs fail before launch. |
| `AUDIT_SHARD_TOTAL` | `8` | Functional shard partitions in a sharded release; allowed range 1–16. |
| `AUDIT_SHARD_CONCURRENCY` | `4` | Maximum functional shard containers active at once; allowed range 1 through `AUDIT_SHARD_TOTAL`. Reduce this first on memory-constrained hosts. |
| `AUDIT_SHARD_WORKERS` | `1` | Playwright workers inside each functional shard; allowed range 1–16. The isolated performance container always uses one. |
| `AUDIT_SHARDED_RUN_ID` | generated | Optional unique 8–80 character lowercase run directory name; an existing directory is refused without mutation. |
| `CANDIDATE_IGNORE_HTTPS_ERRORS` | `0` | Explicit development-only candidate bypass; affected evidence requires review. |
| `PLAYWRIGHT_VERSION` | `1.62.1` | Official image tag version. Must match the package. |
| `INSTALL_MSEDGE` | `0` | Build-time `0`/`1` switch for the optional branded Microsoft Edge channel. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Default advisory evidence-review model. |
| `ANTHROPIC_API_KEY` | unset and not forwarded by Compose | Advanced supervisor-only injection; inspectable container configuration makes the portal vault the recommended path. |
| `AI_REVIEW_DRY_RUN` | unset | Set to `1` to validate AI-stage artifacts without an API call. |

Stopping the container sends a termination signal to the active Playwright process group and allows eight seconds for browser/report cleanup before forcing exit. An interrupted run is preserved and marked failed when the portal next starts, so incomplete evidence is never presented as a passing audit.
