# @harms-haus/engin

> Short for "**Engin**eered **In**ference" — Eng. In. → engin.

[![CI](https://github.com/harms-haus/engin/actions/workflows/ci.yml/badge.svg)](https://github.com/harms-haus/engin/actions/workflows/ci.yml)

A script-based workflow engine for AI-driven development, built on top of [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Install

```bash
git clone <repository-url> engin
cd engin
bun install
bun run build
```

## Quick Start

```bash
# Create the config directory structure
engin init

# Add your own profiles and workflows to ~/.config/engin/
# See docs/README.md for profile and workflow authoring guides

# Run a workflow (assuming you've created a "develop" workflow — see docs/README.md)
engin develop "Add input validation to all public API endpoints"
```

## Documentation

Full documentation is in [docs/README.md](docs/README.md), covering:

- CLI reference and exit codes
- Configuration directory resolution (global + local)
- Agent profiles (markdown + YAML frontmatter)
- Custom workflow authoring
- Programmatic API reference
- Workflow authoring guide
- Types reference

## License

All rights reserved.
