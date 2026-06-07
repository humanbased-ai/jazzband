# Jazzband

Open TypeScript orchestration for ticket-driven agent workflows.

Jazzband is the planned npm-native successor to the current Python Symphony workflow. Its job is
to coordinate agents and tools around a public, inspectable delivery loop:

```text
Linear ticket -> implementation PR -> Crosscheck review -> VerifyFlow delivery verification
```

Jazzband should work as a standalone CLI and as a library. It should coordinate tools without
owning their private config, logs, or state.

## Install

After the first npm release:

```bash
npm install -g @humanbased-ai/jazzband
jazzband --help
```

From source:

```bash
npm install
npm run build
npm start -- plan --ticket IN-123 --repo humanbased-ai/monorepo
```

## Commands

```bash
jazzband plan --ticket IN-123 --repo humanbased-ai/monorepo
jazzband status --pr https://github.com/humanbased-ai/monorepo/pull/456
jazzband run --ticket IN-123 --repo humanbased-ai/monorepo
```

Today these commands return the initial orchestration contract shape. The next implementation
increments will connect Linear, GitHub, Crosscheck, coding agents, and VerifyFlow.

## Design Principles

- TypeScript first, npm installable.
- Works alone, but composes cleanly with Crosscheck and VerifyFlow.
- Public handoffs over private log scraping.
- Separate config, state, and logs for every tool.
- SHA-bound PR annotations for review and verification results.
- Dry-run first; irreversible actions require explicit flags.

## Relationship To Existing Tools

| Tool | Owns |
| --- | --- |
| Jazzband | orchestration, ticket workflow, agent dispatch |
| Crosscheck | code review and merge readiness |
| VerifyFlow | delivery verification and evidence reports |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
