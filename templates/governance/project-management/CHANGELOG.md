# Changelog

All notable product and development changes are recorded here.

This file is not the canonical source for production deployment state.

## Unreleased

### Added

- Added end-to-end trusted evaluator runner.
- Added exact-SHA trusted Claude Code PM target, protected LangSmith experiment runner, result normalizer, certification engine, dataset bootstrap, provenance hashing, and fail-closed certification artifacts.
- Replaced trusted workflow placeholder with real benchmark execution.

- Added trusted evaluator repository architecture.
- Added GitHub App Checks reporter for exact candidate SHA.
- Added protected external evaluator repository skeleton and GitHub App setup guide.
- Added fail-closed trusted evaluation workflow skeleton.

- Added GitHub required PR governance gate workflow.
- Added merge-queue support, internal change classification, fork fail-closed handling, least workflow permissions, and governance workflow static validation.
- Added GitHub governance-gate hardening guide.

- Added Governance Certification Dashboard standard and report template.
- Added category scoring, critical zero-tolerance certification, result generator, sample report, and PM-version comparison script.

- Added 75-case adversarial PM Governance Benchmark v1 for LangSmith.
- Added category/criticality metadata, benchmark bootstrap script, catalog, summary, and runbook.

- Added Claude Code stream-json trajectory adapter and tool-call normalization.
- Added deterministic trajectory Safety/Truth gates.
- Added semantic trajectory governance judge.
- Added plan-safe Claude Code evaluation profile and trajectory expectation template.

- Integrated LangSmith as the agent observability and evaluation layer.
- Added `LANGSMITH.md` governance policy.
- Added LangSmith dataset bootstrap script and 18-case governance regression seed.
- Added real deterministic governance evaluators, OpenEvals semantic judge, target adapter, experiment runner, and CI gate example.
- Added governance evaluation templates and initial evaluation catalog.
- Bound canonical LangSmith project to `Klinik360`.
- Added safe Claude Code tracing configuration example.


### Added

### Changed

### Fixed

### Security

### Deprecated

### Removed
