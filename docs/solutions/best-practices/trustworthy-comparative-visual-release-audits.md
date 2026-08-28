---
title: Trustworthy comparative visual release audits
date: 2026-08-25
category: best-practices
module: ai-mobile-testing
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - comparing a redesigned candidate with a production baseline
  - using browser automation as a release gate across multiple targets
  - generating audit coverage from catalogs or plugin declarations
  - interpreting nonzero browser test exits after evidence collection
symptoms:
  - checks pass because expected values are derived from the same observation being asserted
  - production-only baseline defects incorrectly block the candidate release
  - inapplicable targets appear as coverage but immediately skip
  - exit code 1 is presented as a crashed run even when valid findings and evidence completed
root_cause: missing_validation
resolution_type: workflow_improvement
related_components:
  - observability
  - infrastructure
tags:
  - comparative-testing
  - visual-regression
  - playwright
  - docker
  - release-gating
  - test-oracles
  - observability
---

# Trustworthy comparative visual release audits

## Context

This repository audits a release candidate against a production baseline, with the default origins declared as the beta Cloudflare Pages site and `quitting7oh.org` (`audit/environments.ts:3-11`). The hard part was not getting Playwright to visit both sites in Docker; it was making the resulting verdict mean something. A browser can return HTTP 200, render an H1, and produce screenshots while still showing the wrong document, an incomplete category, a generic recovery shell, or a control that never performs its promised action.

Session review exposed three related failure modes. First, weak assertions could approve “some healthy content” instead of the intended product behavior: broad text matches, minimum counts, self-canonical pages, or expectations inferred from what the candidate rendered. Second, a candidate-only route could be incorrectly treated as though production supplied a comparable baseline, turning a deliberate redesign addition into a skipped or misleading comparison. Third, ordinary Playwright exit code 1 results were displayed like process crashes even when the containers completed normally and produced valid evidence of release-blocking defects.

The current tree turns those lessons into enforceable architecture. Reviewed route identities are declared independently as exact H1/title contracts, with production-only aliases explicitly separated from candidate expectations (`audit/routes.ts:11-18`, `audit/routes.ts:299-326`). The page test collects rendered facts first, passes those facts to a separate route oracle, attaches the resulting evidence, and then requires the issue list to be empty (`tests/page-audit.spec.ts:77-186`). Mutation canaries prove that a self-canonical generic shell, an exact-title but structurally empty article, a category missing one child, and a sitemap missing one destination all fail (`scripts/assertion-quality-self-test.ts:686-772`).

## Guidance

Treat every release assertion as a comparison between an observation and an independently reviewed product oracle. Put exact expected identities, destinations, inventories, boundary vectors, and permitted environment differences in audit-owned data or constants. Do not derive the expected value from the DOM, response payload, route slug, or bundle being tested. Normalize only incidental presentation differences; keep product meaning exact. For example, the route oracle normalizes casing and title suffixes, but still requires the loaded and canonical pathnames, approved canonical origin, one visible H1, reviewed H1/title identity, substantive content, and route-kind-specific structure (`audit/page-oracles.ts:86-105`, `audit/page-oracles.ts:265-367`). Production aliases are added only when the environment is production, so a legacy baseline label cannot weaken the candidate redesign contract (`audit/page-oracles.ts:103-105`).

Keep observation and judgment separate. The browser test should record response status, URL, rendered identity, structure, controls, links, and geometry without using those observations to manufacture its expectations. Then an oracle should return explicit issues, which the test attaches before asserting. This makes a failure explainable and prevents an early assertion from discarding the evidence needed to diagnose it (`tests/page-audit.spec.ts:149-185`). Preserve this separation in feature tests too: the reviewed clonidine result declares an exact query, fragment URL, category/type, title, highlight, and excerpt independently of the search UI (`audit/routes.ts:501-508`).

Define comparison applicability as reviewed product data, not as “run every test everywhere and skip whatever breaks.” Candidate additions are listed explicitly, and production resolution returns `null` for those routes; reviewed renames are mapped explicitly (`audit/environments.ts:14-22`, `audit/environments.ts:51-60`). The same applicability function is used when declaring generated page tests and expanding their portal metadata, so the portal cannot promise a production execution that Playwright will immediately skip (`audit/page-audit-family.ts:15-34`, `tests/page-audit.spec.ts:19-30`). For production-first migration coverage, inventory every production sitemap route, require either a reachable reviewed candidate mapping or an approved removal, and separately reconcile candidate-only additions (`tests/contracts.spec.ts:242-330`).

Make release gating asymmetric by default. The candidate is the thing being released; production is comparison context unless an audit explicitly promises a paired-origin contract. The report model names the small set of cross-environment gates, evaluates all executions for those gates, and otherwise gates on candidate or environment-unknown executions while retaining production failures as non-gating baseline issues (`reporters/report-model.ts:481-485`, `reporters/report-model.ts:843-883`). It also marks production-only findings as baseline context and removes their release-blocking flag in portal data (`reporters/report-model.ts:1642-1666`). Missing applicable candidate executions still count as incomplete; skipped selections never become coverage (`reporters/report-model.ts:831-875`).

Finally, model process integrity separately from product findings. Exit code 1 is a normal Playwright finding outcome only when the stage has no signal or command error and fresh structured evidence exists. Command diagnostics classify explicit errors, signals, and exit codes outside 0/1 as integrity failures (`scripts/lib/pipeline-diagnostics.mjs:7-21`); merge integrity likewise accepts only exit 0 or 1 and requires fresh results (`scripts/lib/merge-stage-integrity.mjs:1-20`). The authoritative checklist must contain a consistent `READY` or `NOT_READY` decision and blocking/integrity counts (`scripts/lib/release-truth.mjs:31-77`). A completed pipeline plus `NOT_READY` deliberately maps to status `not-ready` and exit code 1, whereas an incomplete pipeline maps to `pipeline-failed` (`scripts/lib/release-truth.mjs:91-98`). Do not generalize this into “ignore exit 1”: the coordinator still fails closed on stale or missing lifecycle/checklist evidence, signals, explicit errors, build failure, or disagreement between merge and checklist truth (`scripts/run-sharded-release.mjs:105-147`).

Guard the practice with mutation tests, not conventions alone. The assertion-quality suite rejects broad text-derived homepage expectations and arbitrary minimum-count category checks, requires exact route-contract issues to be asserted, and verifies evidence is attached before assertions can abort (`scripts/assertion-quality-self-test.ts:596-614`). Its route mutations demonstrate the exact wrong pages and partial structures that must remain red (`scripts/assertion-quality-self-test.ts:686-772`). These canaries make future “simplification” of an oracle an executable policy failure.

## Why This Matters

A visual release audit is trustworthy only when a pass rules out plausible wrong implementations. “The page has an H1” does not rule out a custom 404, a generic shell, or a redirect to the homepage. “There are eight links” does not rule out eight wrong links. “The selected search result opened” is tautological if the test accepts whichever result the application selected. Exact independent oracles convert those observations into product claims: this route has this identity, this control reaches this reviewed destination, this inventory is complete, and this boundary produces this exact result.

Environment-aware applicability also prevents two opposite errors. It avoids penalizing a candidate-only feature for lacking a production twin, while still detecting unreviewed production removals and unmapped redesign routes. The release model can therefore answer the useful question—whether the candidate is safe to ship—without hiding regressions or allowing an existing production defect to veto a redesign that fixes it. The report states that policy directly: candidate and unknown executions gate by default, while only explicit paired-origin contracts make production evidence release-authoritative (`reporters/report-model.ts:1028-1044`).

Truthful lifecycle semantics keep operational failures distinct from successful defect discovery. A test container that completes with valid failing assertions has done its job; calling it “crashed” sends reviewers toward Docker instead of the defect. Conversely, a terminated shard or stale report must never be laundered into a legitimate `NOT_READY` result. The coordinator persists pipeline status, release decision, stage exit codes, signals, and the authoritative source separately (`scripts/run-sharded-release.mjs:145-208`). The portal renders a completed nonzero stage as “completed with findings,” includes the exit code, and shows a signal only when one exists (`portal/public/app.js:901-949`); its end-to-end fixture verifies that an exit-1 shard is shown with findings and without a fake signal (`portal/tests/portal.spec.ts:890-899`).

## When to Apply

- A redesign is compared with a live production baseline and some differences are intentional.
- Routes were renamed, added, or removed, so blanket two-origin execution would misstate coverage.
- The product has exact navigation, search, accessibility, calculator, or content-inventory promises.
- Tests run in Docker shards where nonzero browser-test exits and infrastructure termination must be distinguished.
- A portal summarizes many executions and reviewers need to know which findings block release, which are production baseline context, and which indicate broken evidence collection.

Use looser assertions only for genuinely open-ended properties, and even then define the invariant independently—for example, an accessibility rule set, a maximum overflow, or a minimum touch target from an explicit reviewed contract. If a plausible wrong implementation can satisfy the assertion, strengthen the oracle before treating the result as release evidence.

## Examples

### Exact custom not-found behavior

The unknown-route test does not accept a screenshot that merely looks like an error page. It starts from a rendered page, requires the unknown navigation to return HTTP 404, asserts the exact recovery H1, compares the complete recovery-link inventory, verifies that searching `clonidine` points to the environment-specific helper-medications fragment, and then operates the site-map recovery link (`tests/contracts.spec.ts:462-510`). This catches both false-success HTTP responses and visually plausible but incomplete recovery pages.

### Search recovery that proves the destination

`SEARCH-005` first asserts a deterministic no-result state using an absent token. It then replaces the token with the reviewed query, requires the exact `helper-meds#clonidine` href, focuses and activates that result by keyboard, checks the canonical final URL, and verifies that the actual `#clonidine` section is visible (`tests/search.spec.ts:159-183`). The expected fragment comes from the independent reviewed contract, not from the first option returned by the application (`audit/routes.ts:501-508`). The same exact destination, page H1, and fragment visibility are asserted inside the keyboard-only accessibility journey (`tests/accessibility.spec.ts:166-196`), so keyboard mechanics cannot pass while opening the wrong content.

### Calculator boundaries with exact arithmetic

`CALC-002` does not stop at “the calculator still rendered.” It specifies the behavior of a blank draft, malformed native-number input, committed zero, valid decimal at minimum frequency, maximum frequency, and range overflow. It checks exact restored values, schedule row counts, validity flags, exact daily-total text, and the first rendered schedule row (`tests/calculators.spec.ts:175-248`). Those assertions distinguish a resilient boundary policy from a UI that silently preserves stale or nonsensical arithmetic.

### Completed with findings, not crashed

The run truth contract deliberately allows exit code 1 to represent a completed `NOT_READY` audit while reserving pipeline failure for incomplete or invalid lifecycle evidence (`scripts/lib/release-truth.mjs:91-98`). The diagnostic self-test fixes the boundary: exit 1 with no signal/error is ordinary browser-test evidence, while an explicit error, `SIGTERM`, or exit 137 is an integrity failure (`scripts/sharded-isolation-self-test.mjs:231-254`). In the portal, the resulting stage reads “completed with findings,” retains “exit code 1,” and omits a signal when none occurred (`portal/tests/portal.spec.ts:895-899`). Reviewers can therefore trust that red means a discovered product problem unless the separately reported pipeline integrity state says evidence collection itself failed.

## Related

- [End-to-end redesign test plan](../../TEST_PLAN.md)
- [Assertion and audit contract ledger](../../ASSERTION_LEDGER.md)
- [Docker execution and audit portal](../../DOCKER.md)
- [Installed test plugins](../../PLUGINS.md)
- [Requirements traceability](../../REQUIREMENTS_TRACEABILITY.md)
- [Release process](../../RELEASE_PROCESS.md)
- [AI evidence review](../../AI_REVIEW.md)
- [Repository overview](../../../README.md)
