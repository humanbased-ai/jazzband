# Bug intake workflow

Use `triage.mode: bug-intake` only for the Linear project that receives portal bug reports. Jazzband may classify, deduplicate, label and, after its adversarial verifier approves a concrete low-risk fix, open a pull request.

It does not accept or reject a report, grant reputation or USDC, change a reporter-visible decision, merge a pull request, or alter an incident/security ticket. Those are human-owned decisions in Humanbased's bug-report service and operator console.

Other Linear projects start in `triage.mode: general`: Jazzband can label a ticket but cannot promote it to an agent. A project that has explicitly adopted normal autonomous delivery uses `triage.mode: delivery`; use `--strict` there when it needs the same adversarial verification.

```yaml
triage:
  mode: bug-intake
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: online-bug-reports
classifier:
  runner: claude-cli
delivery:
  repo: humanbased-ai/monorepo
  verify: pnpm typecheck
  forbidden_paths:
    - /migrations/
    - /infra/
    - .env
```

Start with [`examples/bug-intake.WORKFLOW.md`](../examples/bug-intake.WORKFLOW.md), set `JAZZBAND_WORKSPACE_ROOT`, then run `jzb watch --workflow bug-intake.WORKFLOW.md --execute`. The command writes only Linear labels/comments and PR links; it never calls the bug-report accept/reward APIs.
