# Docker execution and audit portal

> [!IMPORTANT]
> Single-site and Comparative release authority now use the shared durable runner. Legacy queue/finalizer and sharded commands remain diagnostic during migration and are permanently fenced after shared activation. See [Shared release authority](SHARED_RELEASE_AUTHORITY.md).

The Docker image is the canonical way to run this suite. It pins the Playwright browser image to the same Playwright release used by the project and contains all three browser engines. Comparative results use the host-mounted `artifacts/` directory; durable Single-site jobs, immutable finalizations, and copied visual baselines use dedicated Docker named volumes.

## Start the portal

```sh
npm run portal
```

Open <http://localhost:4173>. The port is bound to localhost by default so the process-launching interface is not exposed to the network.

`npm run portal` runs `docker compose up --build --scale single-site-worker=2 portal single-site-worker single-site-finalizer`. This is the supported complete stack: starting only the `portal` service does not provide a Single-site executor or finalizer. Set `SINGLE_SITE_WORKER_REPLICAS` from 1 through 16 to increase the number of queued jobs that can be claimed concurrently:

```sh
SINGLE_SITE_WORKER_REPLICAS=4 npm run portal
```

Replica count increases throughput across jobs; it does not split one job across several workers. Do not scale the portal itself.

The desktop console has stable direct entries: `/` for Overview, `/runs.html`, `/findings.html`, `/evidence.html`, `/new-audit.html`, `/settings.html`, and `/run.html?mode=<comparative|single-site>&run=<id>` for a live workspace. The report and gallery preserve that mode/run identity. Overview is an operational projection, not a new release authority: Product Risk, Run Trust, active work, and the latest terminal run stay independently sourced. Index responses are cursor-bounded and expose source revision, freshness, completeness, limitations, and work performed. Browser code does not scan every retained report or artifact tree to answer a global page.

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

The stable run workspace owns exactly one mode-appropriate live transport: comparative runs use bounded resumable SSE and Single-site runs use bounded revision polling. Execution, activity, connection, report/finalization, coverage, Evidence Authority, Pipeline Integrity, and manual acceptance remain separate. Logs disclose the visible bounded window, timestamps, source, stage/shard, commands, HTTP responses, FFmpeg context, freshness, pause/tail state, and redaction. A transport failure freezes durable state and reports reconnection; it cannot mutate the run or imply that server work stopped.

The reviewer report is the browser-safe Long Build Checklist. Report generation writes compact summary, audit-index, and bounded per-audit detail documents into `checklist/data/revisions/<revision>/`, hashes every document in that revision's publication manifest, and makes the set authoritative only with the final atomic `checklist/data/current.json` rename. The report page pins filtered and detail requests to the exact revision returned with its summary; external terminal runs fail evidence integrity if any declared document is missing, substituted, or from another generation. Compatibility mirrors remain at `checklist/data/summary.json`, `checklist/data/audits.json`, and `checklist/data/audits/`, but they are not release-authoritative. The portal enforces 256 KiB, 2 MiB, and 512 KiB limits for the three layers, filters and paginates audits on the server, aborts superseded browser requests, and keeps the DOM bounded to one 25-row page and one audit detail. The 59 MB-class `checklist/manifest.json` is never fetched by the report page; it is offered only as an explicitly large download. Likewise, the recent-log panel is opt-in and capped at 64 KiB while complete persisted log files remain direct evidence downloads.

The general run console also stays bounded: its log endpoint defaults to a 256 KiB UTF-8-safe tail with a hard 1 MiB ceiling and reports each source file's complete size and truncation state. SSE replay is capped at 512 KiB, slow clients receive an overflow notice instead of accumulating an unbounded queue, and the browser batches incoming lines before one DOM update. Large media and traces stream with `Content-Length`, `Accept-Ranges`, and HTTP 206 support instead of being buffered in memory.

Known external-run reads use stale-while-revalidate behavior: the portal returns its last safe snapshot immediately and schedules filesystem refresh work asynchronously. Each refresh has one global 2 MiB read budget and 250 ms time budget across lifecycle, heartbeat, and incremental log ingestion; remaining work waits for a later refresh instead of blocking a browser request. After a portal restart, exact active-test progress is restored from `sharded-heartbeat.json`. Persisted logs remain the verbose evidence trail, but restart recovery uses bounded tail/incremental reads and never scans an unbounded log prefix to reconstruct counters.

Evidence labels reflect the capture policy instead of implying every check has a video. Action-to-response interactions may show a playable video and FFmpeg poster with their recorded rationale. Static visual verification uses screenshots. Each audit displays the actual video and screenshot counts available for that run.

The live gallery does not load an entire Single-site inventory before it becomes usable. It requests the immutable head and one bounded page, resolves an out-of-window deep link through a revision-bound anchor with queue position, and loads next/previous windows on demand. Publication, baseline-store, review, filter, and order revisions bind those reads; stale cursors and superseded selection requests cannot commit. The generated archive is a separate immutable versioned asset/data bundle with no live API, credential, EventSource, saved-view, stop, purge, or disposition dependency. Runtime N accepts the documented legacy N-1 descriptor, rejects unsupported future or mismatched bundles, and remains usable through direct `file://` with networking unavailable.

Every launch receives an isolated directory at `artifacts/runs/<run-id>/`. Its `run.json` records the targets, selection, browser projects, safe command arguments, progress, timestamps, and exit result. `logs/runner.log` preserves the complete timestamped process output. The test reporters write their evidence into the same run directory through `AUDIT_ARTIFACT_DIR`.

Legacy portal status has three independent parts: pipeline state, checklist result, and provenance/review reasons. Those fields remain readable as diagnostic history, but neither a portal checklist nor a new sharded legacy run is release authority after shared activation. The shared current head supplies the revisioned decision, certified scope, and Risk Register used by automation.

After Playwright exits—whether its checks pass or fail—the portal runs a visible evidence pipeline: video hashing/poster indexing, optional AI evidence review, then a final checklist rebuild. That rebuild discovers each FFmpeg-generated sibling `*-poster.jpg`, copies it into the checklist evidence directory, records its size and checksum, uses it as the video preview, and exposes a separate poster link. Videos without a generated poster remain playable and linked exactly as before. Each command has a persisted lifecycle record with start/end time, duration, exit status, and live stage-prefixed output. A required video/report failure produces the distinct non-green `evidence-failed` result. AI remains advisory and cannot turn a failed deterministic audit green.

The portal does not accept commands or test paths. It starts the local Playwright executable directly—without a shell—and only after checking projects, profiles, audit areas, and audit IDs against allowlists loaded from the repository. Target URLs must be plain HTTP(S) origins without credentials, paths, query strings, or fragments. Only one run is allowed at a time by default; a synchronous reservation closes concurrent-launch races before filesystem work begins. Runner and lifecycle append streams must report that they opened before registration/spawn proceeds, and retain error handlers afterward; stream, persistence, or spawn-setup failure becomes a terminal failure without holding capacity. Manual rebuild streams use the same open/error contract. Every request first crosses a loopback/explicit Host allowlist, and every shared-control mutation additionally requires a scoped operator principal plus same-origin browser metadata and CSRF proof. When authorization is needed, use the in-page banner and enter the scoped credential stored inside the portal container at `/var/lib/ai-mobile-testing/shared/credentials/local-cutover-operator.credential`; the banner displays the exact `docker compose exec` command to read it from the repository directory. The page exchanges the credential for an HttpOnly, strict same-site session cookie, clears the field immediately, and never persists the credential in browser storage. The legacy append-and-open unlock remains available only for explicitly enabled compatibility surfaces and must not be used by New Audit. Workers never receive operator credentials. This blocks co-resident workers, DNS rebinding, and cross-origin artifact documents from controlling credentials, runs, or purge. `PORTAL_ALLOWED_HOSTS` may add an intentional local hostname; do not expose the portal as a shared service.

Manual uploads are serialized with attestations and checklist rebuilds per run, so concurrent requests return `409` instead of overwriting `manual-evidence.json`. PNG, JPEG, WebM, and MP4 declarations are checked against their byte signatures, probed for a visual stream and valid dimensions, and decoded through the first frame under a bounded timeout before the file is renamed or can support a passing attestation. Invalid and interrupted temporary/final files are removed. Artifact responses open the contained final file with no-follow semantics before headers, stream from that descriptor with range support, and handle disappear/stream errors without crashing the portal.

Installed test suites come only from the generated, validated `audit/plugins.generated.json` registry. The registry includes the 102 expanded `PAGE-*` route checks, so those checks appear individually in the portal instead of existing only inside an implicit loop. Selecting a suite merges and deduplicates its allowlisted spec paths, constrains the selected browser projects to the plugin's supported-project list, and builds an escaped audit-ID grep from that suite's definitions. A shared spec can therefore serve several suites without accidentally executing its sibling checks. The portal never accepts a spec path from the browser.

### Optional AI evidence review

AI review is opt-in for each portal run. Open Claude settings in the portal to save, replace, or delete the credential. The server encrypts saved credentials with AES-256-GCM in the Compose-project-scoped `portal-secrets` Docker volume mounted at `/var/lib/ai-mobile-testing/secrets`, outside `/work` and Playwright's test-discovery tree. The browser receives only configured state and a short one-way fingerprint. It never stores the key locally or sends it in a run request.

Compose deliberately does not forward `ANTHROPIC_API_KEY`: container environment/configuration is inspectable and frequently captured in diagnostics. Save the key in the portal instead. A separately managed deployment may still inject an environment key directly into the supervisor, but operators must treat its container configuration as secret-bearing.

The root portal supervisor owns the mode-0700 vault. Playwright and video processing run as the image's non-root `pwuser`; AI review runs as non-root `aiworker`; and checklist generation runs as a distinct non-root `reportworker`. Every worker environment removes the vault path, operator capability, and every key source. `aiworker` shares only the completed run-artifact group and cannot read the vault or inspect browser processes as the same UID. The supervisor sends the selected key once over an anonymous stdin pipe, so it does not appear in the AI worker environment. Artifact downloads walk from a pinned run-directory descriptor and open every component with no-follow semantics, so an ancestor rename cannot redirect a root portal read into the vault. Before any request, the AI worker likewise freezes bounded regular evidence files through contained canonical paths. After browser, media, and AI work, the supervisor removes symlinks, rejects hard links and non-regular artifacts, makes the run tree read-only to worker identities, gives `reportworker` one private staging directory, and atomically publishes the completed checklist. Credential settings and AI launch are disabled unless all three worker identities are established. A portal-saved key is accepted only by the operator-authorized credential endpoint and is never echoed. No key reaches a run manifest, event stream, log, command summary, report, or artifact. The default model is `claude-sonnet-5`; override it with `ANTHROPIC_MODEL` at container startup or in the validated model field for one launch. `AI_REVIEW_DRY_RUN=1` exercises the stage and output contract without an API request.

The review appears under `ai-review/` as `review.json`, `index.html`, `review.md`, and a provider-safe lifecycle log. The portal displays only allowlisted telemetry: model, response status, latency, and token usage. It does not display request/response bodies or headers.

## Single-site Audit operations

Single-site Audit tests one quitting7oh deployment with standalone Product Oracles; it does not need a production/candidate pair. In the portal, choose **Audit one site**, enter an HTTP(S) origin, confirm its **Preview** or **Production** deployment role, choose the certificate policy, and select **Check site and preview coverage**. Preflight is side-effect-free and creates no run. It verifies quitting7oh identity and shows the proposed targets, definitions, executable cases, comparison-only exclusions, and Coverage Gaps. Launch repeats preflight and compilation atomically so a stale preview cannot silently become a job.

Choose scope deliberately:

- `FULL` is the complete versioned Single-site profile with all default neutral targets and no plugin, audit, area, or target narrowing.
- `TARGETED` is a selected subset. Filtering by plugin, audit ID, area, or target is targeted evidence even if every selected check passes.

The default Single-site matrix is mobile Chromium, desktop Chromium, mobile WebKit, tablet WebKit, and desktop Firefox. The target picker also exposes reviewed opt-in iPhone/iOS, Pixel/Android, Galaxy/Android, Edge-compatible Chromium, and capability-gated branded Edge profiles. These mobile profiles are Docker browser emulations, not physical iOS, Mobile Safari, Android Chrome, or real devices; required physical-device and assistive-technology checks remain manual.

The run page follows durable execution state, worker lease/activity, last event, bounded live logs, finalizer progress, report publication, and advisory AI independently of the browser's SSE connection. A dropped browser connection does not stop work. Once finalized, open the Single-site report at `/report.html?mode=single-site&run=<run-id>` and the evidence workbench at `/gallery.html?mode=single-site&run=<run-id>`.

The report does not collapse different kinds of truth into one green mark:

| Dimension | Meaning |
| --- | --- |
| Release Decision | `RELEASE READY`, `FEATURE READY`, or a stable `NOT READY` code for the executed scope. A required execution, action video, media stage, or publication-integrity failure yields incomplete execution and blocks that scope. |
| Scope | Always `FULL` or `TARGETED`; a targeted `HEALTHY` verdict describes only that subset. |
| Coverage | `COMPLETE`, `GAPS`, or `UNKNOWN`, independently reporting missing standalone oracles, executable variants, targets, and route limitations. |
| Manual acceptance | Human-only outstanding, passed, failed, or blocked work. Automation and AI cannot complete it. |
| Visual Review | `UNCHANGED`, `CHANGED`, or human-dispositioned `REVIEWED` for compatible same-site baselines, plus explicit absent, incompatible, and unavailable states. It routes visual drift to review and never changes a deterministic Finding, Coverage, or Site Health. |
| Evidence Authority | Authoritative only when the deployment revision and certificate policy support it. Preview certificate bypass makes the run non-authoritative. |
| Pipeline Integrity | Whether evidence collection, FFmpeg processing, immutable publication, and report generation completed safely. |

Comparison-only migration mappings and production/candidate content-parity definitions are recorded as outside Single-site mode; they are not run against one origin and do not masquerade as Coverage Gaps. Route discovery is bounded and source-attributed, so undiscovered or unsupported route coverage remains visible as a limitation.

### Command launch

Keep `npm run portal` running, then submit a job from a second terminal through the portal container so it uses the same durable named volume:

```sh
docker compose exec portal node scripts/run-single-site.mjs \
  --queue-root /var/lib/ai-mobile-testing/jobs \
  --url https://beta.quitting7oh-org.pages.dev \
  --role preview \
  --scope FULL
```

The complete command contract is:

```text
node scripts/run-single-site.mjs --queue-root <path> \
  (--launch <launch.json> | --url <origin> --role <preview|production> \
  [--certificate-policy strict|preview-bypass] [--scope FULL|TARGETED] \
  [--targets id,...] [--plugins id,...] [--audits id,...] [--areas name,...] \
  [--ai-review model-id] [--idempotency-key key])
```

`AUDIT_JOB_QUEUE_ROOT` may supply `--queue-root`. Omitting `--targets` selects the complete default Single-site target profile. Omitting `--scope` derives `TARGETED` when plugin, audit, or area filters are present and otherwise derives `FULL`; set it explicitly in automation. `--launch` consumes a previously prepared, validated launch document instead of performing a direct URL preflight. The adapter prints accepted preflight/coverage and created-or-reused job JSON, then returns; execution and finalization continue asynchronously in the pools. `--ai-review` opts that run into the named advisory model, but the portal supervisor still needs an available saved credential or `AI_REVIEW_DRY_RUN=1`.

### Reproducible beta proofs

With the complete portal, worker, and finalizer stack running, these commands submit named beta scenarios, print accepted coverage, follow durable queue events and finalization state, and finish with the exact report and gallery links:

```sh
npm run single-site:beta:smoke
npm run single-site:beta:targeted
npm run single-site:beta:full
npm run single-site:beta:baseline-follow-up
```

The smoke proof covers interaction contracts on mobile Chromium and the desktop `CONTENT-001` named visual capture required for the baseline workflow. The targeted proof covers navigation, search, and calculators on mobile and desktop Chromium. The full proof uses the complete versioned Single-site target profile. Before the baseline follow-up proof, inspect and approve the eligible desktop `CONTENT-001` screenshot from the smoke run in the gallery; the follow-up intentionally repeats the same Preview role, desktop target, Audit Definition, and rendering identity so compatible comparison is possible. Baseline approval remains an explicit human action and is never performed by the proof command.

Each proof defaults to strict certificates. Pass extra arguments after `--` to choose the bounded Preview exception or a different timeout, for example `npm run single-site:beta:smoke -- --certificate-policy preview-bypass --timeout-minutes 120`. The origin must also appear exactly in `AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST`; bypass evidence remains non-authoritative.

The terminal `proof-finished` event includes a compact receipt that binds the named scenario and canonical run scope to runner/source, preflight, coverage, route-inventory, and reconstructed preview revisions; the terminal queue result and fencing token; the exact authoritative worker-publication attempt and digests; finalization/report/gallery/media/visual publication digests; the proof command's result mapping derived from terminal finalization status; and report/gallery URLs. The `command.exitCode` field is that deterministic mapping (`complete` maps to `0`, every other terminal finalization maps to `2`), not an independently observed operating-system process exit.

Before that event is printed, the content-addressed receipt is atomically published and read back as `<single-site-finalization>/<run-id>/beta-proof-receipt.json`. Verification rereads the digest-bound queue job and canonical worker input, validates its coverage and route-inventory documents, reconstructs the accepted preview digest, rederives the durable finalization from the queue, and opens every referenced report, gallery, media, and visual publication. A missing or corrupt referenced publication, or a recomputed status/receipt that disagrees with the durable finalization, is rejected. An identical restart reuses the receipt, while older finalizations with no receipt remain readable as receipt-absent. Optional revision fields remain `null` when the corresponding older authority did not publish them. The receipt caps the displayed publication list and includes a digest and count for the complete current set; it never copies event logs, result reasons, evidence bodies, credentials, or AI payloads.

After the named legacy proofs finish, generate a bounded machine-readable closeout manifest from their durable job IDs. The generator re-verifies every receipt and publication before copying report truth and gallery/media/visual counts. This closeout is diagnostic migration evidence; only a shared publication can become the current release head:

```sh
node scripts/single-site-completion-evidence.mjs \
  --jobs <smoke-job>,<targeted-job>,<full-job>,<follow-up-job> \
  --output /work/single-site-completion-evidence.json
```

The generated manifest deliberately does not claim that a baseline approval or `REVIEWED` disposition occurred. Record the exact baseline-store revision/history digest, baseline identity/media, and review-store event separately when closing that human workflow.

After approving the source screenshot and completing the compatible follow-up run, generate that separate digest-bound human-workflow record. It re-verifies both run receipts, the source eligibility publication, baseline history and copied media bytes, the follow-up comparison, and the optional review history. A compatible `UNCHANGED` or `CHANGED` result is sufficient; `REVIEWED` is included only when a matching disposition actually exists:

```sh
node scripts/single-site-baseline-follow-up-evidence.mjs \
  --source-job <source-job> \
  --follow-up-job <follow-up-job> \
  --output /work/single-site-baseline-follow-up-evidence.json
```

The emitted record contains both receipt digests, baseline `storeRevision` and `historyDigest`, the exact baseline identity and media SHA-256, the approval event, the follow-up current/baseline/diff SHA-256 values and comparison status, plus `reviewRevision`, review `historyDigest`, and event when the item is `REVIEWED`.

### Worker and finalizer boundaries

The `single-site-worker` replicas run Playwright as `pwuser` and claim durable jobs from the `single-site-jobs` volume. The `single-site-finalizer` consumes sealed attempts, processes videos with FFmpeg, builds a contained processed copy, computes visual comparisons, and crash-safely publishes immutable report and gallery revisions to `single-site-finalizations`. Neither service receives the `portal-secrets` volume or a Docker socket. Visual baseline media is copied independently into `single-site-baselines`.

`AUDIT_QUEUE_POLL_MS` controls both pools' idle polling interval from 100 through 60000 milliseconds; the default is `1000`. More worker replicas improve throughput for multiple jobs. Keep `single-site-finalizer` at one replica: the current pool safely verifies/reuses immutable output after restart, but it does not claim a per-job finalization lease for active/active replicas. The finalizer is a separate service so browser work and evidence publication recover independently, not so one run is concurrently published by several containers.

### Shared-runner Docker resilience gate

Run the authoritative shared-runner topology and recovery proof with:

```sh
npm run shared-docker-resilience:self-test
```

The gate cannot be weakened through environment overrides: the package command selects the explicit `--authoritative` mode, which requires exactly three trials, a Compose build invocation, 1 CPU, and 2 GiB per ordinary worker. For local troubleshooting, `npm run shared-docker-resilience:diagnostic` selects the separate `--diagnostic` mode and writes `shared-docker-resilience-diagnostic.json`; reduced trials, skip-build, or resource overrides in that mode cannot replace the authoritative evidence file or satisfy `npm run shared-docker-resilience:check`.

The gate builds the pinned audit image once, pre-warms each topology, and executes the same sealed eight-item workload in three recorded trials with one ordinary worker principal and with the separate ordinary A+B principals. Each worker is limited to one browser at a time, 1 CPU, and 2 GiB. Every trial uses a fresh project-scoped canonical named volume while reusing warm image layers. The report records every wall time, variance, medians, throughput improvement, Docker CPU/memory samples, workload and invariant digests, fixed resources, and recovery identities at `artifacts/self-tests/shared-docker-resilience-proof.json`.

The workload includes one deterministic product assertion failure. It must publish once without an assertion retry. The gate also transitions 1→2→1, SIGKILLs the worker and coordinator Node processes so Docker restart policy recovers them, proves already-adopted evidence is unchanged, and requires only unfinished work to receive a bounded infrastructure retry. Its fixture and environment flag are isolated from normal audit selection and cannot be launched through the portal.

The proof intentionally runs `docker compose down` before its final inspection to demonstrate that named-volume state survives container removal. `docker compose down -v` is destructive and is never a recovery action. The harness uses it only for exact nonce-prefixed disposable proof projects and refuses destructive cleanup outside that generated prefix. Do not use `down -v` on the portal or a retained audit project unless permanent deletion of its named-volume state is intended.

### Same-site visual baselines and Finding waivers

The gallery compares only exact compatible identities: deployment role, route, target, viewport, theme, audit definition, named capture point/state, and rendering-contract fingerprint. A completed eligible screenshot can be approved; an active baseline can later be replaced, revoked, or have retained media deleted. Baselines never advance automatically.

- No compatible baseline yields an `absent` visual state; the run can still complete and the current screenshot remains reviewable.
- A rendering-contract mismatch yields `incompatible`, not `CHANGED`.
- An eligible difference yields `CHANGED`; an exact match yields `UNCHANGED`. A reviewer may record either an accepted-change or known-defect disposition with a required rationale and exact `REVIEW <item-id>` confirmation. The append-only review record is bound to the exact run, item, comparison, active baseline media, and store revision. A stale baseline is rejected and must be reloaded before review; successful disposition yields `REVIEWED` without changing deterministic Findings, Site Health, Coverage, or the sealed run publication.
- Approving or replacing evidence that has an unresolved Finding requires a written `findingWaiverReason`. The waiver accepts that image as a baseline only; it does not remove the Finding or change Site Health.

Mutation dialogs preview the exact identity and require the displayed phrase: `APPROVE <evidence-id>`, `REPLACE <baseline-id> <evidence-id>`, `REVOKE <baseline-id>`, or `DELETE <baseline-id>`. Approval copies media into the independent baseline volume, records append-only provenance and digests, and does not modify repository screenshot expectations. Deleting retained media preserves the tombstoned baseline history. There is currently no automatic age-based baseline garbage collector; revoke or delete retained media explicitly according to the team's retention policy.

### Retention and purge

Single-site jobs, finalizations, and baselines are Docker named-volume data, not files under `artifacts/`. Back them up or export required evidence before Docker volume removal. There is currently no automatic age-based run retention policy.

To reclaim a terminal Single-site run, choose **Purge run and evidence** and type `PURGE <run-id>` exactly. Active work is refused. Purge validates the direct job/finalization children, symlinks, mounts, and baseline mutation state, then journals and atomically moves the run into a private quarantine before deletion. It is irreversible. Independently copied active baseline bytes and their lifecycle history survive; links back to the purged source run may no longer resolve.

### Recovery and troubleshooting

- **Run is queued indefinitely:** confirm that `single-site-worker` is running and that `single-site-volume-init` completed successfully. Start the full stack with `npm run portal`, not `docker compose up portal`. Inspect the live portal log and `docker compose logs single-site-worker`.
- **Browser work finished but no report appears:** confirm `single-site-finalizer` is running and inspect `docker compose logs single-site-finalizer`. A required FFmpeg/media/report failure must publish `INCOMPLETE`, never a stale `HEALTHY` result.
- **A worker or host restarted:** queued state and sealed attempts persist in the named volume. An expired lease can be reclaimed with a higher fencing token; late output from the old attempt cannot publish. Restart the full stack and follow the retained log rather than resubmitting immediately.
- **Finalization restarted:** complete immutable publications are verified and reused; incomplete temporary output is safely rebuilt. Sealed worker attempt bytes are never modified by video processing or report generation.
- **The portal disconnected:** execution state comes from the durable queue, not the SSE connection. Refresh or use the reconnect control; retained logs remain authoritative.
- **An interrupted purge appears as `evidence-failed`:** retry purge from that retained row. Recovery targets only the journaled quarantine child.
- **AI was pending or running during restart:** deterministic finalization remains complete, while that AI attempt becomes unavailable and can be retried after a credential is available. The key is not persisted with the run.
- **A run is non-authoritative:** inspect Evidence Authority. A Preview certificate bypass or unavailable deployment revision is not repaired by passing browser checks; rerun strict against a revision-identifiable deployment for authoritative evidence.

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

Intentional console visual changes use a separate Docker-only update command:

```sh
npm run portal:e2e:update-snapshots
```

Inspect every regenerated image at 1280, 1440, 1920, and the narrow fallback before retaining it. Update mode does not satisfy the gate; rerun `npm run portal:e2e` normally and require it to pass against the reviewed files. The container runs as the host artifact owner, so Linux-generated reports and snapshots do not require a root cleanup step.

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

Candidate and production TLS remain strict (`CANDIDATE_IGNORE_HTTPS_ERRORS=0`), and the image-baked/development CA flow handles inspected development traffic. A value of `1` fails before browser launch because Playwright and Chromium expose only context/process-wide bypasses, which cannot enforce the promised exact candidate-origin scope.

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

Horizontal portal replicas are not supported. The portal live registry and in-flight credential are process-local, while evidence and named volumes are shared storage. Scaling the portal can therefore bypass its concurrency limit and give different replicas incomplete live state. Supported parallelism is the comparative shard coordinator described above and up to 16 Single-site worker replicas across queued jobs. Keep one portal, one Single-site finalizer, and exactly one comparative merge publisher.

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

Comparative `CANDIDATE_IGNORE_HTTPS_ERRORS` accepts only `0` or `1` and defaults to `0`, but `1` is deliberately rejected for every origin. Playwright's `ignoreHTTPSErrors` and Chromium's `--ignore-certificate-errors` apply beyond one origin to redirects and subresources, so labeling either mechanism “candidate-only” would be false. Install the development/Netskope CA instead. The portal keeps the comparative control disabled with that explanation, and CI forces `0` and runs the fail-closed TLS policy checks inside the built image.

Single-site Audit supports an explicitly bounded development exception because only one deployment origin is authoritative. `--certificate-policy preview-bypass` and the portal's Preview bypass option are accepted only when both conditions hold:

1. the operator confirms deployment role `preview`; and
2. the exact normalized origin is present in comma-separated `AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST`.

For the shipped beta origin:

```sh
AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST=https://beta.quitting7oh-org.pages.dev npm run portal
```

Production-role Single-site runs always use strict TLS. The allowlist constrains which audited origin may request the exception; Playwright's browser-context bypass can still cover that run's redirects and subresources. The exception therefore does not make invalid certificates trustworthy: it records `development-certificate-bypass` and downgrades Evidence Authority to non-authoritative. Passing required work may still yield a scope-qualified ready decision, but promotion policy must explicitly reject or separately handle the non-authoritative evidence; readiness alone is insufficient. Prefer installing the correct public Netskope/development CA; use bypass only to diagnose an explicitly allowlisted Preview deployment.

## Durable evidence and permissions

`./artifacts` is bind-mounted to `/work/artifacts`. Back up release-candidate run directories to durable object storage; CI artifacts are useful for review but are not permanent archives. Keep the run manifest with its reports and videos so the evidence retains its target URLs and execution context.

On Linux and Docker Desktop, the entrypoint aligns `pwuser` with the numeric owner of the artifact bind mount and puts the distinct AI/report workers in that artifact group. The `portal-e2e` service additionally drops from root to the bind mount's numeric owner with a private temporary home, cleared supplementary groups, and `no-new-privs`, so its retained test evidence remains readable and removable by the host user. This avoids host-specific `chown` failures without weakening the root-only credential volume. If a Linux login was newly added to the `docker` group, start a new login shell or run `newgrp docker` before invoking Compose. `npm run docker:identity:self-test` proves real bind ownership, UID/GID collisions, queue collaboration, certificate mounts, and fail-closed root-owned targets.

If a mounted filesystem still refuses ownership transitions, the run records `portable-bind` permission provenance: completed files, subdirectories, and the run root remain read-only to the worker group. The root supervisor temporarily opens only the exact publication or manual-evidence paths it owns, never makes the parent group-writable, and reseals every success, rollback, and error path. The three workers retain distinct UIDs and none can read the mode-0700 vault.

To reclaim local storage, open a terminal-state run in the portal, choose **Purge run and evidence**, and type the displayed `PURGE <run-id>` phrase exactly. The operation is unavailable while work is active. It validates the exact direct-child path, refuses symlinked or nested mounted content, writes a root-only durable journal, and atomically renames the run beneath `.portal-purge-quarantine` before recursive deletion. Success removes the journal and portal row. A crash or partial deletion leaves a durable `evidence-failed` quarantine row after restart; retrying purge targets only that validated random quarantine child. Purging is irreversible and is not an archive workflow.

Direct smoke/release services use the official Playwright image's root execution model and are intended only for the two trusted project origins. Portal launches use a stricter four-identity split: the root supervisor owns the credential vault and lifecycle state; Playwright and FFmpeg run as `pwuser`; advisory AI review runs as `aiworker` with one-shot stdin secret delivery; and checklist generation runs as `reportworker` against a frozen source tree and private staging directory. All workers receive sanitized environments and none can read the vault. Do not point this suite at arbitrary untrusted sites. A deployment designed for hostile origins also needs Playwright's recommended seccomp profile and a separately reviewed container boundary.

## Continuous integration

`docker-smoke.yml` builds the exact image, validates the shared-runner resilience proof, and runs the legacy smoke profile for diagnostic coverage on pull requests, pushes to `main`, and manual dispatch. Smoke never certifies release scope. `.github/workflows/release-audit.yml` is the live shared-authority workflow for both modes, and `.github/workflows/exact-promotion.yml` is the only provided production delivery path.

`release-audit.yml` is manual by design. It accepts the two target origins and worker count, runs the full suite inside Docker, and retains the release evidence for 90 days. Evidence uploads run regardless of outcome, then CI enforces the authoritative checklist decision together with the recorded pipeline status. Only a completed pipeline with `release.decision: READY` is green.

## Operational controls

These optional variables affect the portal container:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORTAL_PORT` | `4173` | Host port mapped to the portal. |
| `PORTAL_MAX_CONCURRENT_RUNS` | `1` | Concurrent launches, capped by the server at four. |
| `SINGLE_SITE_WORKER_REPLICAS` | `2` | Worker service replicas started by `npm run portal`; allowed range 1–16. Increases throughput across queued jobs, not within one job. |
| `AUDIT_QUEUE_POLL_MS` | `1000` | Idle polling interval for the Single-site worker and finalizer pools; allowed range 100–60000 ms. |
| `AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST` | unset | Exact comma-separated Preview origins allowed to request Single-site `preview-bypass`; the result is non-authoritative. Production and comparative runs remain strict. |
| `PORTAL_SHARDED_ARTIFACT_ROOT` | `/work/artifacts/sharded` | Discovery/evidence root for terminal-launched releases; active execution stays read-only, terminal evidence may be purged with confirmation. |
| `PORTAL_ALLOWED_HOSTS` | `portal` | Comma-separated extra local hostnames accepted by the request Host guard. The default permits the bounded Compose service name used by shared control clients; loopback names are always allowed. |
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
| `CANDIDATE_IGNORE_HTTPS_ERRORS` | `0` | Must remain `0`; browser-wide bypass requests fail closed because exact-origin scope is unavailable. |
| `PLAYWRIGHT_VERSION` | `1.62.1` | Official image tag version. Must match the package. |
| `INSTALL_MSEDGE` | `0` | Build-time `0`/`1` switch for the optional branded Microsoft Edge channel. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Default advisory evidence-review model. |
| `ANTHROPIC_API_KEY` | unset and not forwarded by Compose | Advanced supervisor-only injection; inspectable container configuration makes the portal vault the recommended path. |
| `AI_REVIEW_DRY_RUN` | unset | Set to `1` to validate AI-stage artifacts without an API call. |

Stopping the container sends a termination signal to the active Playwright process group and allows eight seconds for browser/report cleanup before forcing exit. An interrupted run is preserved and marked failed when the portal next starts, so incomplete evidence is never presented as a passing audit.
