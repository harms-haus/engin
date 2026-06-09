# workflow-harness

A script-based workflow engine for AI-driven development, built on top of [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

## Install

```bash
git clone <repository-url> workflow-harness
cd workflow-harness
npm install
npm run build
```

## Quick Start

```bash
# Install default profiles and the develop workflow
workflow-harness init

# Run the develop workflow
workflow-harness develop "Add input validation to all public API endpoints"
```

## Documentation

Full documentation is in [docs/README.md](docs/README.md), covering:

- CLI reference and exit codes
- Configuration directory resolution (global + local)
- Agent profiles (markdown + YAML frontmatter)
- Custom workflow authoring
- Programmatic API reference
- Develop workflow phases and architecture
- Types reference

## License

All rights reserved.
