# Shared release authority

Single-site and Comparative audits use one durable release architecture. The mode changes the Product Oracle, not scheduling, recovery, risk, decision, or promotion semantics.

## Release contract

- A `FULL` Single-site audit can grant `RELEASE READY` for the exact audited deployment. A `TARGETED` audit can grant `FEATURE READY` only for its certified scope.
- A Comparative audit can grant the same authority while adding paired candidate-regression and production-baseline oracles.
- Deterministic product failures and failed visual assertions block the certified scope.
- Required work that is missing, corrupt, abandoned after bounded retry, or owned by an unrecovered worker makes that scope `NOT READY — INCOMPLETE EXECUTION`.
- Manual checks and unresolved human-review risks remain prominent and non-blocking until a deterministic automated test fails. They never silently become passes.
- Every mode publishes the same revisioned Release Decision, Risk Register, operation history, report, gallery, and archive projection.

The portal is a control and review surface. The canonical release head lives in the shared durable store and is the only source accepted by CI. Historical legacy `READY` files and shadow-validation output are diagnostic only.

## Runtime topology and scaling

The supported deployment is one Docker Engine with named volumes:

- one portal/control surface;
- one fenced shared coordinator with the canonical store mounted read/write;
- one or more ordinary browser workers with no canonical-store mount;
- one exclusive performance worker;
- one shared worker exchange and separately scoped file-only credentials.

Scaling from one worker to many changes scheduling only. It must not change the final subject, ordered work/oracle membership, normalized result classes, evidence membership/provenance, risks, or decision. Keep exactly one coordinator and one canonical store. Multi-host authority is not supported.

The legacy Single-site finalizer and Comparative runner remain available only while the canonical legacy-authority fence is `OPEN`. Every authority-bearing legacy process requires `AUDIT_LEGACY_AUTHORITY_FENCE_ROOT`. `CLOSED` drains accepted finalizations, `FROZEN` blocks every legacy mutation, and `ACTIVATED` permanently retires legacy release authority. Missing or corrupt fence state fails closed.

## Recovery and rekick

Workers heartbeat and publish fenced, per-execution evidence. Operational failures receive only bounded platform retries; a deterministic product failure is terminal and is never retried into a pass. If recovery is exhausted, that execution remains incomplete while unrelated work continues.

Use incomplete-only rekick to preserve completed work and the immutable subject. A same-subject rerun of a product failure is diagnostic and cannot erase the canonical failure. Portal/coordinator restarts resume durable operations; stale leases and stale worker publications are rejected.

`docker compose down` removes containers but preserves named-volume authority. `docker compose down -v` destroys the canonical store, queues, credentials, baselines, and retained state; it is deletion, never recovery.

## CI and release codes

`.github/workflows/release-audit.yml` runs live shared-authority canaries for both modes. It requires a published control origin and a scoped `shared_control_token`. The workflow stores the token only in a mode-0600 file, uploads only the non-secret shared CI receipt, and fails with the stable control-client class when the current decision is not ready, stale, incomplete, unauthorized, or identity-mismatched.

The process exit classes are defined in `shared/control-client-contract.mjs`: success, not ready, stale revision, identity mismatch, evidence unavailable, authorization failure, timeout, request failure, and usage error. Automation should branch on the exit code and retained receipt, never on log text or a legacy checklist.

## Exact promotion

`.github/workflows/exact-promotion.yml` is a reusable delivery workflow. The caller supplies one immutable GitHub artifact ID containing:

```text
site/
release-artifact-manifest.json
candidate-deployment.json
shared-release-result.json
```

The manifest binds every relative path to its byte length and SHA-256 digest. The candidate receipt binds those bytes and source revision to the audited candidate deployment. Immediately before delivery, CI rechecks the artifact, asserts the current shared head, consumes a short-lived single-use claim for the exact subject/revisions, rechecks the bytes again, and runs the pinned Wrangler Direct Upload command. Cloudflare and delivery credentials are file-only and are removed before the non-secret receipt is uploaded.

A provider retry can create a duplicate deployment record with identical bytes because Cloudflare deployment creation has no idempotency key. The shared claim and receipt serialize authority; an operational duplicate does not create different release truth.

## Cutover and rollback

Cutover closes admission, drains legacy work, validates store and backup identity, proves the shadow matrix, freezes legacy authority, advances the shared selector exactly once, and reopens with both-mode canaries. Before activation, the owning cutover may reopen the drained legacy build. After activation, rollback is limited to a prequalified shared-compatible build that honors the current schema and authority epoch; legacy `READY` can never be restored.

Snapshot restoration invalidates later decisions. Keep promotion disabled until new authoritative runs establish a fresh current head.

## Plugin extension contract

New features enter through the validated plugin registry. A plugin must declare stable audit IDs, supported modes, standalone and/or comparative oracle variants, release policy, evidence mode, allowlisted specs, and target support. Validation rejects missing assertions, comparison-only checks masquerading as Single-site coverage, unregistered specs, and interaction checks without bounded action/response video evidence. Follow [PLUGINS.md](PLUGINS.md), then run the full pinned Docker validation before enabling the plugin in release scope.
