# Development Guide

This document covers local setup, testing, and coverage for contributors.

## Prerequisites

- **Node.js 24.x** (matches CI and the Docker image)
- **npm** (bundled with Node)
- Optional: [Doppler CLI](https://docs.doppler.com/docs/cli) for running the bot with secrets locally

## Install

```bash
npm ci
```

## Run the bot locally

With Doppler (recommended):

```bash
npm run dev      # nodemon + Doppler
npm start        # production-style start
```

Deploy slash commands:

```bash
npm run commands:deploy
```

## Testing

### Unit and integration tests

```bash
npm test
```

This runs the full suite with [Jest](https://jestjs.io/) using shared setup in [`test/jest.setup.cjs`](../test/jest.setup.cjs) and [`test/jest.afterEnv.cjs`](../test/jest.afterEnv.cjs), which stub Discord, AI SDKs, and Sentry.

**CI runs `npm test` only** — coverage is not generated or uploaded in GitHub Actions.

### Coverage gate (local / maintainer)

100% coverage is enforced locally with Jest's V8 coverage provider:

```bash
npm run test:coverage:check
```

Thresholds (lines, branches, functions, statements) are defined in [`jest.config.cjs`](../jest.config.cjs). Coverage output is written to `coverage/` and is gitignored.

On Windows, run the command directly in PowerShell without piping output — piping can cause Jest to hang.

### Pre-deploy check

```bash
npm run predeploy   # runs tests, then deploys commands
```

## Docker

Production images are built from the multi-stage [`Dockerfile`](../Dockerfile). The build context excludes tests and coverage tooling via [`.dockerignore`](../.dockerignore):

- `test/`
- `jest.config.cjs`
- `coverage/`, `*.lcov`, `.nyc_output/`

Runtime images contain application code and production dependencies only (`npm ci --omit=dev`).

## Project layout

| Path | Purpose |
|------|---------|
| `index.js` | Discord client bootstrap |
| `config.js` | Environment-driven configuration |
| `instrument.js` | Sentry initialization and helpers |
| `logger.js` | Pino logging with Sentry forwarding |
| `events/` | Discord event handlers |
| `commands/` | Slash commands |
| `utils/` | AI providers and helpers |
| `test/` | Test suite (not shipped in Docker) |

## Further reading

- [Observability](./observability.md) — Sentry errors, traces, logs, and metrics
- [README](../README.md) — deployment and configuration
