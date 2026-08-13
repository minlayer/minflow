# Contributing to minflow

Thank you for your interest in contributing.

## Development Setup

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/minlayer/minflow.git
   cd minflow
   ```

2. Install dependencies (Node.js 20 or newer):

   ```bash
   npm install
   ```

3. Run the test suite to verify your setup:

   ```bash
   npm test
   ```

## Code Style

- **Linting and formatting**: [Biome](https://biomejs.dev/)
- **Type checking**: `tsc --noEmit`, with `strict` enabled
- **Tests**: [Vitest](https://vitest.dev/)

## Quality Checks

Run all checks before submitting a pull request:

```bash
npm run check
```

That runs lint, typecheck, and tests. To apply formatting fixes:

```bash
npm run format
```

## Pull Requests

1. Create a feature branch from `main`.
2. Make your changes with clear, focused commits.
3. Add an entry to [CHANGELOG.md](./CHANGELOG.md) under `Unreleased`.
4. Ensure all quality checks pass.
5. Open a pull request with a clear description.

## Reporting Issues

Use [GitHub Issues](https://github.com/minlayer/minflow/issues) to report bugs
or request features.
