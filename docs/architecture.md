# Jazzband Architecture

Jazzband coordinates a delivery workflow without becoming the source of truth for every tool.

## Core Loop

```text
1. Load scope from Linear.
2. Plan implementation work.
3. Dispatch or resume an implementation agent.
4. Observe the GitHub PR.
5. Wait for Crosscheck APPROVE on the current head SHA.
6. Invoke VerifyFlow for delivery verification.
7. Decide next action: merge, request fixes, or ask for human input.
```

## Public Contracts

Jazzband should read and write public artifacts:

- Linear issue/project metadata
- GitHub PR links, labels, comments, and statuses
- Crosscheck SHA-bound review markers
- VerifyFlow SHA-bound delivery markers
- JSON CLI output from cooperating tools

It should not parse private logs from Crosscheck or VerifyFlow.

## Local State

Default state locations:

- config: `~/.jazzband/config.json`
- runs: `.jazzband/runs/`
- logs: `.jazzband/logs/`

The exact schema will be versioned before the first production release.
