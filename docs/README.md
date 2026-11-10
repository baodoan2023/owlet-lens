# Documentation index

## For users
- [Quick start (GitHub)](../README.md)
- [Usage reference](./usage.md): Action inputs/outputs, strict mode, exit codes, provider env vars, token permissions
- [Configuration reference](./config.md): every `ai-review.config.yaml` key
- [LLM data policy](./llm-data-policy.md): what is sent to the LLM
- [GitLab setup](./gitlab-setup.md)
- TL gate setup: [GitHub](./tl-gate-github-setup.md), [GitLab](./tl-gate-gitlab-setup.md), [Bitbucket](./tl-gate-bitbucket-setup.md), [Azure DevOps](./tl-gate-azure-devops-setup.md)
- Examples: [`../examples/`](../examples/)

## For maintainers
- [CONTRIBUTING.md](../CONTRIBUTING.md): start here
- [CONTEXT.md](../CONTEXT.md): domain vocabulary
- [CLAUDE.md](../CLAUDE.md): architecture, conventions, exit codes
- Architecture decisions (ADRs):

| # | Topic | Decision |
|---|---|---|
| 0001 | State | [Cross-run identity lives in comment markers, not a state file](./adr/0001-marker-based-state-no-state-file.md) |
| 0002 | Reconcile | [Reopen is permissive, close is strict](./adr/0002-asymmetric-reconcile-guards.md) |
| 0003 | Providers | [Bitbucket markers: runtime probe with inline-code fallback](./adr/0003-bitbucket-marker-style-probe.md) |
| 0004 | Learn | [The learn pipeline harvests security findings like any other category](./adr/0004-learn-harvests-security-findings.md) |
| 0005 | LLM | [Model failover tries each model once, and only on retryable errors](./adr/0005-model-failover-single-attempt-per-model.md) (partly superseded by 0021) |
| 0006 | Release | [`dist/` is gitignored and only the Release workflow commits it](./adr/0006-dist-built-only-by-release.md) |
| 0007 | Reply | [Reply verdicts come from an LLM, not a regex](./adr/0007-llm-reply-verdict.md) |
| 0008 | LLM | [Reflection filter uses batch calls, not per-finding calls](./adr/0008-reflection-filter-batch-not-per-finding.md) |
| 0009 | LLM | [Reflection skips CRITICAL findings unconditionally](./adr/0009-reflection-skips-critical-findings.md) |
| 0010 | Config | [Dual-key coding standards (`codingStandardsPath` + `codingStandards`)](./adr/0010-dual-key-coding-standards.md) |
| 0011 | LLM | [Semantic file bundling applies to overflow chunks only](./adr/0011-semantic-chunking-overflow-only.md) |
| 0012 | Providers | [Providers own platform concerns](./adr/0012-providers-own-platform-concerns.md) |
| 0013 | Providers | [Providers retry each request; a create repeats only when it did not land](./adr/0013-provider-retries-per-request.md) |
| 0014 | Gate | [The TL gate reads its switch and lead list off the PR's target branch](./adr/0014-tl-gate-reads-the-target-branch.md) |
| 0015 | Review | [Skip a push whose review fingerprint matches the last full review](./adr/0015-skip-unchanged-review-fingerprint.md) |
| 0016 | Gate | [The strict gate counts open blocking threads from earlier runs](./adr/0016-strict-gate-counts-open-blocking-threads.md) |
| 0017 | Review | [`review.severityThreshold` drops findings below it, not just the strict gate](./adr/0017-severity-threshold-filters-findings.md) |
| 0018 | Naming | [The project is named Owlet Lens; identifiers stored in other people's data keep `ai-review`](./adr/0018-project-name-and-wire-format-identifiers.md) |
| 0020 | LLM | [OpenRouter routes privately by default and pins providers per model](./adr/0020-openrouter-privacy-default-routing.md) |
| 0021 | LLM | [Any failed attempt moves to the next model, and fallbacks can switch provider](./adr/0021-fallback-on-any-failure-across-providers.md) |

## History (not current documentation)
- [`specs/`](./specs/): design specs for v1.5/v1.6 features. Kept for background; the code and ADRs are authoritative.

## Logo
The logo files are in `docs/assets/logo`: SVG for light and dark backgrounds (the text is converted to outlines, so it renders without the font) and PNG exports of the badge. The badge alone is the avatar; `owlet-lens-avatar-1024.png` is a square version on a white background for social profiles.

## README images
The images in the README (`docs/assets/*.png`) are rendered from the HTML in `docs/assets/src/`; each file starts with the Chrome command that produces it. `social-preview.png` is for GitHub's repository social preview (Settings, 1280x640) and has to be uploaded there by hand. The platform logos in `docs/assets/logos/` are the brands' own marks, used only to show compatibility.
