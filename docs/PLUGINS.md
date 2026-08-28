# Installed test plugins

Plugins are reviewed, repository-local test packages. They group audit definitions and exact Playwright spec files so the portal can launch a focused part of the suite without accepting a command or arbitrary path from a browser request.

Five first-party plugins are installed:

| Plugin | Scope |
| --- | --- |
| `platform-routes-content` | Origins, routes, redirects, content, visual baselines, homepage, crisis path, and SEO |
| `shell-navigation-theme-search` | Global shell, drawers, reading navigation, themes, breakpoints, and search |
| `calculators-sows` | Taper calculators, arithmetic, persistence, exports, SOWS, and sharing |
| `meetings` | Meeting timing, timezones, discovery, history, joins, and failure states |
| `accessibility-responsive-performance-reliability` | WCAG, keyboard use, reduced motion, performance, resilience, and real-device gates |

Together they own all 183 entries in the long build checklist: 81 feature and cross-cutting contracts plus 102 generated route contracts. Every generated route is a first-class portal row that can be selected individually, filtered under Routes, or launched with the platform suite. Some checklist entries are deliberately manual. A manual audit remains visible as not run until a reviewer records it; installing a plugin does not turn a manual check into an automated green mark.

## Files

Each installed directory contains a `plugin.json`. The disabled starter lives at `plugins/_template/` and is excluded from the generated registry.

```text
plugins/
├── platform-routes-content/plugin.json
├── shell-navigation-theme-search/plugin.json
├── calculators-sows/plugin.json
├── meetings/plugin.json
├── accessibility-responsive-performance-reliability/plugin.json
└── _template/
    ├── plugin.json
    └── tests/starter.spec.ts
```

`audit/plugins.ts` is the schema, validator, discovery API, and allowlist builder. `scripts/validate-plugins.ts` validates every manifest and atomically regenerates `audit/plugins.generated.json`. The generated JSON is intentionally plain data so the non-TypeScript portal can consume the same checked registry as Playwright and the report builder.

Run validation after any plugin change:

```sh
npm run plugins:validate
```

Commit the manifest and regenerated registry together. Continuous integration should use check mode, which validates everything but fails instead of rewriting a stale registry:

```sh
npm run plugins:check
```

The Docker image build and both GitHub audit workflows run the combined `npm run validate` gate. It checks the generated registry, proves inline P0/manual metadata remains release-blocking end to end, type-checks core, AI, and plugin TypeScript (including the disabled starter), and exercises the fail-closed TLS policy before any browser audit can run.

## Manifest contract

```json
{
  "schemaVersion": 1,
  "id": "example-audit",
  "version": "1.0.0",
  "name": "Example audit",
  "description": "What user outcomes this plugin protects.",
  "enabled": true,
  "tags": ["content"],
  "auditDefinitions": [
    { "id": "CONTENT-001", "source": "core" }
  ],
  "auditFamilies": [],
  "entrySpecs": [
    "tests/page-audit.spec.ts",
    "plugins/example-audit/tests/example.spec.ts"
  ],
  "supportedProjects": [
    "candidate-mobile-chromium"
  ]
}
```

An audit declaration has two forms:

- `{ "id": "CONTENT-001", "source": "core" }` references an existing definition in `audit/catalog.ts`. Discovery resolves it to the canonical definition.
- A complete inline definition adds a new audit. It must provide `id`, `area`, `title`, `userPromise`, `severity`, `releaseBlocking`, `expected`, a non-empty `evidence` array, an `evidencePolicy` with an explicit mode and human-readable rationale, and its Single-site classification. The starter manifest contains an inline example.

The reviewed platform plugin also declares `"auditFamilies": ["candidate-html-routes"]`. This one allowlisted family expands the canonical route inventory into exact `PAGE-*` definitions and exactly one `tests/page-audit.spec.ts` applicability case per route. Routes with a reviewed production mapping use `full-sweep-projects`; candidate additions with no production equivalent use `candidate-full-sweep-projects`, so the portal never advertises a production execution that will immediately skip. The generated registry contains the expanded definitions and cases, so the portal does not need to understand TypeScript or invent hidden test IDs. Unknown or duplicate family names, a missing page spec, a missing or duplicated generated case, altered generated metadata, or any disagreement with the route inventory fails validation.

Inline definitions use the same areas, severities, evidence types, and evidence modes as the core catalog. `interaction-video` requires video and a stated action/response; `static-screenshot` requires a relevant screenshot; `structured-data` forbids decorative media. Every definition must also declare how it behaves in Single-site Audit:

- `standalone-compatible` means the normal case has an independent one-origin expectation. It requires a `standaloneOracle` with a stable `id` and explicit `expected` behavior; generated case metadata supports both `comparative` and `single-site` modes.
- `comparison-only` means the promise fundamentally needs both origins, such as migration mapping or production/candidate parity. The Single-site compiler records it as outside mode and never executes it against one origin.
- `standalone-required` means the comparative case is not itself a valid one-origin oracle, but a separately reviewed Single-site case can be supplied. If that case is missing, the definition becomes an explicit Coverage Gap rather than an automatic pass.

The generated registry retains the complete definition and each case's `supportedModes` and `oracleVariants`. The fixture, compiler, portal, and report builder reject missing or conflicting metadata instead of inventing non-blocking defaults.

## Supported projects

Only executable Docker-local IDs from `audit/targets.ts` may appear in a manifest. The stable comparative defaults are:

- `production-mobile-chromium`
- `candidate-mobile-chromium`
- `production-desktop-chromium`
- `candidate-desktop-chromium`
- `candidate-mobile-webkit`
- `candidate-tablet-webkit`
- `candidate-desktop-firefox`

Reviewed opt-in emulation and Edge IDs documented in [`docs/DOCKER.md`](DOCKER.md#browser-and-device-target-matrix) are also valid; provider-only real-device metadata is not. The manifest declares compatibility, not an instruction to launch every listed project. Comparative launch intersects requested projects with this allowlist. The Single-site compiler maps compatible cases onto neutral `single-site-*` targets and retains the source comparative target ID for provenance; a plugin does not invent or execute a second origin.

## Single-site execution rule

Single-site selection uses generated `auditCases`, not definition titles alone. For each selected definition the compiler:

1. excludes `comparison-only` definitions as outside mode;
2. requires a case whose `supportedModes` contains `single-site` and whose `oracleVariants.singleSite` matches the reviewed Product Oracle;
3. maps that case to compatible neutral Single-site targets;
4. records missing variants or omitted required targets as Coverage Gaps; and
5. freezes selected and omitted definitions, cases, targets, and reasons in the Definition Coverage Manifest before execution.

Do not copy a comparative assertion and merely point both sides at the same origin. A standalone oracle must describe an independently observable product outcome. Assertions must fail for plausible broken implementations, and a status code or non-empty element alone is insufficient when the user promise is behavioral.

## Portal execution rule

The portal must treat `audit/plugins.generated.json` as its only plugin execution input. For selected plugin IDs it should:

1. Reject IDs absent from the registry.
2. Merge and deduplicate the selected plugins' `entrySpecs`.
3. Intersect requested browser projects with every selected plugin's `supportedProjects`.
4. Build an audit-ID filter from only the selected plugins' `auditDefinitions[].id`.
5. start the local Playwright executable directly, without a shell.

The audit-ID filter matters because one core spec can contain tests from more than one plugin. `tests/shell-content.spec.ts`, for example, contains shell, homepage, crisis, sharing, and reliability audits. Shared spec paths are allowed across manifests and are deduplicated at launch; the allowlisted audit-ID filter prevents unrelated sibling tests from running.

The portal must never accept a spec filename, regular expression, command, argument list, or working directory from the UI. Display labels and tags are not executable values.

## Validation and safety boundaries

Validation rejects:

- invalid or duplicate plugin IDs;
- invalid or duplicate audit IDs;
- unknown core audit references;
- missing, invalid, or contradictory Single-site classification, standalone Product Oracle, case mode, or oracle variant metadata;
- unknown audit areas, severities, evidence types, or browser projects;
- unknown manifest fields or generated audit-family IDs;
- duplicate values inside tags, audits, entries, evidence, or projects;
- absolute paths, backslashes, non-normalized paths, and `..` traversal;
- entry files outside `tests/**/*.spec.ts` or `plugins/<directory>/tests/**/*.spec.ts`;
- plugin-local entries that point into another plugin;
- missing files and symlinks that escape the repository;
- enabled plugin directories whose name differs from the plugin ID.

The repository-level validation command also fails when any core catalog audit or any `tests/**/*.spec.ts` file is absent from all enabled plugins. This prevents a new check from silently existing outside the portal's runnable surface.

Audit IDs and entry specs must also be unique enough for safe targeting. Audit IDs have one enabled owner. A spec may be shared only because portal execution pairs the deduplicated path allowlist with the selected audit-ID allowlist.

## Creating a plugin

1. Copy `plugins/_template` to a lowercase kebab-case directory.
2. Make the manifest `id` match the directory name.
3. Replace the sample audit with core references or complete inline definitions.
4. Put plugin-owned tests under `plugins/<id>/tests/`, or reference reviewed core files under `tests/`.
5. Give every Playwright title its bracketed audit ID, such as `[EXAMPLE-001]`.
6. Register each comparative or dual-mode case with the matching shared declaration pair: `interactionTest` plus `interactionEvidence`, `staticTest` plus `staticEvidence`, or `structuredTest` plus `structuredEvidence`. For a `standalone-required` static definition, add a separate `standaloneStaticTest` plus `standaloneStaticEvidence` declaration with its literal applicability and reviewed oracle-variant ID. The rationale is required and becomes report context. Every interaction test must wrap its observable action and response assertion in a named `audit.step`; the shared fixture uses that boundary for the video label and bounded before/after pacing. It then records observations, findings, relevant checkpoints, runtime errors, traces, and only the media allowed by that declaration. Enabled plugin definitions resolve automatically from the generated registry. During development of a disabled plugin, call `audit.setDefinition(fullDefinition)` as shown by the starter; it validates the complete definition and refuses to replace registered P0, blocking, evidence-policy, Single-site classification, oracle, or manual metadata.
7. Assert a user-visible outcome and attach enough context to diagnose a failure. A response status or green checkbox alone is not an adequate audit.
8. Set `enabled` to `true`, run validation, inspect the generated registry diff, and run the plugin in Docker.

Do not place secrets, credentials, executable hooks, package-install instructions, or shell fragments in a plugin manifest. Dependencies remain centrally reviewed and pinned by the repository and Docker image.

## Discovery API

TypeScript consumers can use:

- `discoverInstalledPlugins(root, options)` for validated manifests and resolved full audit definitions;
- `createPluginRegistry(plugins)` for stable portal/report data;
- `installedPluginRegistry(root)` for one-step discovery;
- `pluginEntryAllowlist(registry, selectedIds)` for normalized, deduplicated spec paths;
- `CANONICAL_PROJECTS` for the only accepted project identifiers.

Disabled plugins are omitted by default. Pass `includeDisabled: true` only for validation or development tools; a portal must never expose a disabled plugin as runnable.
