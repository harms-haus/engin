#!/usr/bin/env bash
set -euo pipefail

# ─── Install @harms-haus/engin globally via bun (workspace layout) ───────────
#
# The repo is now a 5-package bun workspace. The public CLI lives in
# packages/cli (@harms-haus/engin); its `bin` runs the TypeScript entrypoint
# directly (`src/cli.ts`, `#!/usr/bin/env bun`), and its workspace deps
# (@harms-haus/engin-engine/-shared/-tui) resolve from the hoisted root
# node_modules (module resolution is relative to the script file, so it works
# regardless of the caller's cwd).
#
# This script:
#   1. Verifies the CLI entrypoints are present
#   2. Registers @harms-haus/engin globally via `bun link` (this both exposes
#      the `engin` bin and makes `import { ... } from '@harms-haus/engin'`
#      resolvable from workflow scripts)
#   3. Falls back to a manual ~/.bun/bin/engin symlink if `bun link` did not
#      place the bin on PATH
#   4. Verifies the `engin` command runs and the package imports cleanly
#
# Usage:
#   ./install-global.sh            # (re)install / link from this repo
#   ./install-global.sh --force    # force re-link

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$SCRIPT_DIR/packages/cli"
PKG_NAME="@harms-haus/engin"
BUN_BIN_DIR="$HOME/.bun/bin"

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[engin]${NC} $*"; }
warn()  { echo -e "${YELLOW}[engin]${NC} $*"; }
error() { echo -e "${RED}[engin]${NC} $*" >&2; exit 1; }

# ─── Pre-flight checks ──────────────────────────────────────────────────────
command -v bun &>/dev/null || error "bun is not installed. Install it from https://bun.sh"

FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=true ;;
    esac
done

# ─── Step 1: Verify the CLI entrypoints are present ──────────────────────────
info "Verifying CLI entrypoints..."
[ -f "$CLI_DIR/src/cli.ts" ]   || error "CLI entrypoint not found: packages/cli/src/cli.ts"
[ -f "$CLI_DIR/src/index.ts" ] || error "Public API entrypoint not found: packages/cli/src/index.ts"

# ─── Step 2: Remove any previous global link/bin ─────────────────────────────
# A stale symlink left over from a prior (single-package) install can shadow
# the new one, so remove it first.
if [ -L "$BUN_BIN_DIR/engin" ] || [ -f "$BUN_BIN_DIR/engin" ]; then
    info "Removing previous global bin link..."
    rm -f "$BUN_BIN_DIR/engin"
fi

# ─── Step 3: Register the package globally via `bun link` ────────────────────
info "Linking $PKG_NAME globally (bun link)..."
(
    cd "$CLI_DIR"
    if [ "$FORCE" = true ]; then
        bun link --force
    else
        bun link
    fi
)

# ─── Step 4: Ensure the `engin` bin is on PATH (fallback to a manual symlink) ─
# `bun link` normally creates the bin in ~/.bun/bin; if it did not (or the dir
# is absent), create the symlink ourselves — the shebang runs it under bun.
mkdir -p "$BUN_BIN_DIR"
if ! command -v engin &>/dev/null && [ ! -x "$BUN_BIN_DIR/engin" ]; then
    warn "`bun link` did not place \`engin\` on PATH; creating a manual symlink."
    ln -sf "$CLI_DIR/src/cli.ts" "$BUN_BIN_DIR/engin"
fi

# ─── Step 5: Verify the `engin` command ─────────────────────────────────────
if command -v engin &>/dev/null; then
    info "✓ \`engin\` command available at $(command -v engin)"
else
    warn "\`engin\` not found in PATH. Ensure $BUN_BIN_DIR is in your PATH."
    warn "  Add this to your shell profile:"
    warn '    export PATH="$HOME/.bun/bin:$PATH"'
fi

# ─── Step 6: Verify imports resolve for workflow scripts ────────────────────
info "Verifying package resolves for workflow scripts..."

VERIFY_SCRIPT=$(cat <<'BUN'
// Verify @harms-haus/engin is importable from a workflow-like location.
try {
    const mod = await import("@harms-haus/engin");
    const exportedKeys = Object.keys(mod);
    if (exportedKeys.length === 0) {
        console.error("ERROR: Package loaded but exports are empty.");
        process.exit(1);
    }
    console.log(`OK: Found ${exportedKeys.length} exports from @harms-haus/engin`);
} catch (err) {
    console.error(`ERROR: Failed to import @harms-haus/engin: ${err.message ?? err}`);
    process.exit(1);
}
BUN
)

RESULT=$(bun -e "$VERIFY_SCRIPT" 2>&1) || {
    error "Package import verification failed:\n$RESULT"
}
info "✓ $RESULT"

# ─── Done ────────────────────────────────────────────────────────────────────
info "✅ $PKG_NAME linked globally."
info "   Command:  engin"
info "   Run:      engin run develop \"your task here\""
info "   Server:   engin server up   (then \`engin run\` or open the web UI)"
