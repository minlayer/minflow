# minflow

[![npm](https://img.shields.io/npm/v/minflow.svg)](https://www.npmjs.com/package/minflow)
[![CI](https://github.com/minlayer/minflow/actions/workflows/ci.yml/badge.svg)](https://github.com/minlayer/minflow/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Early development.** This package is published to reserve the name and to
> establish the release pipeline. There is no usable API yet, and everything in
> the `0.0.x` line may change without notice.

## Status

`minflow` is at `0.0.0`. The package installs and imports cleanly, but exports
nothing beyond a version constant. Follow the
[changelog](./CHANGELOG.md) for the first functional release.

## Install

```bash
npm install minflow
```

## Usage

```ts
import { VERSION } from "minflow";

console.log(VERSION);
```

## Related packages

| Package | Description |
| --- | --- |
| [`minlayer`](https://www.npmjs.com/package/minlayer) | Core package. |
| [`minlayer-claude`](https://www.npmjs.com/package/minlayer-claude) | Claude integration. |
| [`minflow`](https://www.npmjs.com/package/minflow) | This package. Name reserved, early development. |

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check   # lint, typecheck, and test
npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Ariel Arevalo
