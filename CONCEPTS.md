# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Audit model

### Audit Definition

A reviewed product promise with an independent expected outcome, release severity, blocking intent, and evidence policy. Executable audit cases separately pair the definition with target applicability.

### Audit Target

A declared browser, device class, viewport, and fidelity combination on which applicable audit definitions can execute. Comparative runs bind it to an environment; Single-site Audit binds a neutral target to the one deployment origin.

### Audit Execution

One selected Audit Definition and Audit Target execution, including any retry attempts, with retained observations, steps, findings, and evidence.

An execution that is skipped or does not apply to its target is not test coverage.

### Single-site Audit

An Audit mode that evaluates one quitting7oh deployment using only standalone Product Oracles and produces an advisory Site Health Verdict without requiring a second origin.

### Scope Qualifier

The `FULL` or `TARGETED` label attached to a Single-site Audit. `FULL` means the complete versioned Single-site profile without narrowing filters; `TARGETED` means a selected subset of definitions, cases, areas, plugins, or targets. It qualifies Site Health and is not a synonym for Coverage Status.

### Deployment Role

The operator-confirmed intent of a Single-site Audit target as Preview or Production, which governs role-dependent expectations independently of hostname inference.

### Product Oracle

An independently reviewed expectation used to judge an observation without deriving the expected value from the system under test.

### Evidence

The retained visual or structured record that explains what an Audit Execution observed and how it reached its result.

### Same-site Visual Baseline

One Visual Evidence item from an explicitly approved completed Single-site Audit that may be reused only for a compatible Deployment Role, route, browser target, viewport, theme, Audit Definition, and named visual state or capture point.

A Same-site Visual Baseline never advances automatically and remains separate from repository-managed screenshot expectations.

### Baseline Lifecycle State

The append-only approved, replaced, revoked, or media-deleted state of a Same-site Visual Baseline. Approval copies digest-bound media into independent baseline storage; purging its source run does not remove that copy, though the source provenance link may stop resolving.

### Finding Waiver

A written rationale required when evidence with an unresolved Finding is approved or used to replace a Same-site Visual Baseline. It accepts that evidence only for baseline lifecycle purposes and never removes the Finding, changes Site Health, or authorizes promotion.

### Coverage Gap

A missing standalone Product Oracle, executable variant, or reviewed route contract. A Coverage Gap describes test coverage rather than an observed defect in the deployed website and is not a Finding.

### Coverage Status

The COMPLETE, GAPS, or UNKNOWN conclusion produced from the Single-site Audit coverage manifest, kept separate from the Site Health Verdict.

### Definition Coverage Manifest

The immutable pre-execution record of selected and omitted Audit Definitions, executable cases, Product Oracle variants, Audit Targets, comparison-only exclusions, and known Coverage Gaps for one run.

### Route Inventory Manifest

The immutable source-attributed route set frozen after reviewed catalog, deployment manifest or sitemap, rendered navigation, and bounded discovery inputs have been reconciled for one run.

### Preflight Preview

A side-effect-free identity and scope preview for a proposed Single-site Audit. It is not an execution capability: launch repeats preflight and compilation atomically before creating a durable job.

### Deployment Revision Fingerprint

The explicit build identifier or reviewed asset-manifest and response-validator evidence used to detect whether one sharded audit would otherwise mix evidence from different deployments. It is distinct from stable quitting7oh identity markers.

### Visual Review Status

The UNCHANGED, CHANGED, or REVIEWED state vocabulary for one compatible Same-site Visual Baseline comparison. It routes visual drift into human review without becoming a deterministic Finding or promotion decision. The shipped comparator produces UNCHANGED or CHANGED; REVIEWED is reserved but is not yet a persisted portal mutation.

Absent, incompatible, and unavailable comparisons remain explicit non-comparison states rather than being coerced to UNCHANGED.

### Manual Acceptance Status

The separately reported state of catalogued physical-device, assistive-technology, or other human-only checks. Automated execution and advisory AI cannot satisfy, waive, or hide outstanding manual work.

## Release truth

### Finding

A specific mismatch between observed product behavior and a Product Oracle, recorded with severity, detail, and blocking intent.

### Baseline Context

A production-side issue preserved for comparison and diagnosis that does not block the candidate unless the Audit Definition explicitly requires paired-environment evidence.

### Evidence Authority

The status that determines whether retained Evidence is trustworthy enough to participate in a release decision, independently of whether the observed product behavior passed or failed.

### Pipeline Integrity

The validity and completeness of evidence collection, processing, and publication, kept separate from product Findings.

### Media Finalization Publication

The immutable Single-site stage that copies referenced attempt evidence into a contained working set, runs required FFmpeg retention and quality gates, and binds sealed source, processed results, and video-manifest digests without modifying the worker's sealed attempt bytes.

### Release Decision

The authoritative conclusion produced from release-blocking outcomes on applicable candidate and environment-unknown executions, required paired-environment contracts, incomplete coverage, and Pipeline Integrity.

### Site Health Verdict

The advisory HEALTHY, FINDINGS, or INCOMPLETE outcome for a Single-site Audit's automated scope, always qualified as FULL or TARGETED and by Evidence Authority, and kept separate from Coverage Status, promotion authority, and outstanding manual work.

### AI Advisory State

The pending, running, completed, failed, or unavailable state of an explicitly opted-in AI interpretation performed after deterministic Single-site publication. It has no promotion or mutation capability and cannot change Site Health, Coverage, manual acceptance, Evidence Authority, or visual/baseline state.

## Execution control

### Fenced Job Attempt

One leased attempt to execute a queued stage or shard, identified by an attempt ID and monotonically increasing fencing token. Only the current token may checkpoint or publish authoritative artifacts, so output from an expired worker cannot overwrite recovered work.

### Rendering Contract Fingerprint

The recorded browser build, device-pixel ratio, capture-contract revision, runner image, and font provenance needed to decide whether two otherwise matching visual captures are comparable.

### Execution State

The durable queued-to-terminal state of audit work, kept separate from worker activity and from whether a reviewer's browser is connected to live updates.

### Activity State

The normal, stalled, or recovering condition derived from worker leases and current attempts rather than from the presence or absence of visible log lines.

### Connection State

The connecting, connected, reconnecting, or offline condition of one portal browser's live event stream. It does not change audit Execution State.

### Purge Quarantine

The private, journaled location to which a terminal run's validated queue/finalization directories are atomically moved before irreversible deletion. It permits bounded crash recovery and never includes independently copied active baseline media.

## Portal presentation

### Visual Evidence Gallery

A run-scoped review surface that presents visual audit evidence as contextual Logical Media Items rather than as an undifferentiated file list.

The active selection owns foreground priority. Adjacent previews are background conveniences: they wait until selected evidence is usable, and obsolete work cannot change the accepted selection after navigation or revision changes.

### Logical Media Item

One contextual occurrence of visual evidence for an Audit Execution, retaining its test, target, capture, and audit associations while grouping the member media needed to review that occurrence.

Logical Media Items are distinct from stored media blobs: identical bytes captured by different tests remain separate review items because their audit context differs.

### Product Risk

A non-authoritative portal attention queue that orders canonical Findings and explicitly labelled visual-review or manual-attention records for operator review. Every item retains its source type and authority; Product Risk is not a Release Decision, Site Health Verdict, or durable audit state.

### Run Trust

A non-authoritative portal grouping of mode-appropriate coverage conclusions, Evidence Authority, Pipeline Integrity, Manual Acceptance Status, finalization state, and source freshness. It presents those facts independently and never collapses them into a new green/red verdict.

### Comparable Predecessor

The latest eligible completed run with the same audit mode, audited deployment or environment pair, compatible profile and scope, and compatible Audit Target set. Portal novelty and change claims may use only a Comparable Predecessor; if none exists, the absence of a valid comparison remains explicit.

### Console Summary Index

A rebuildable, non-authoritative portal projection that bounds cross-run source work for Overview, Runs, Findings, Evidence, and Timeline reads. It carries source watermarks and incompleteness explicitly and can be discarded without changing audit runs, evidence, verdicts, finalization, baselines, or review history.

### Sealed Archive

A publication-atomic, revision-pinned, self-contained, mutation-free report or gallery export that remains reviewable without the live portal. “Sealed” describes package consistency and immutability after publication; it does not imply encryption, confidentiality, or cryptographic authenticity, and purging the live run cannot revoke independent copies.

## Relationships

- An Audit Definition expands into applicable Audit Executions across Audit Targets.
- A Definition Coverage Manifest fixes planned execution scope before a Route Inventory Manifest adds deployment route evidence.
- Each Audit Execution may produce Findings and Evidence.
- Evidence Authority and Pipeline Integrity determine whether execution results may support a Release Decision.
- Baseline Context remains visible without vetoing the candidate unless the Audit Definition makes both environments release-authoritative.
