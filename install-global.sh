#!/usr/bin/env bash
set -euo pipefail

# ─── Install @harms-haus/engin globally via bun ─────────────────────────────
#
# This script:
#   1. Builds the package from source
#   2. Installs it to bun's global node_modules
#   3. Links the `engin` CLI command to ~/.bun/bin/
#   4. Verifies that workflow scripts (e.g. ~/.config/engin/workflows/develop/main.ts)
#      can import from "@harms-haus/engin"
#
# Usage:
#   ./install-global.sh            # install from this repo
#   ./install-global.sh --force    # force reinstall even if already installed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="@harms-haus/engin"
GLOBAL_DIR="$HOME/.bun/install/global"

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

# ─── Step 1: Build ───────────────────────────────────────────────────────────
info "Building $PKG_NAME..."
cd "$SCRIPT_DIR"
bun run build

# Verify the build produced what we expect
[ -f dist/cli.js ]   || error "Build failed: dist/cli.js not found"
[ -f dist/index.js ] || error "Build failed: dist/index.js not found"

# ─── Step 2: Remove previous global install ──────────────────────────────────
if [ -d "$GLOBAL_DIR/node_modules/@harms-haus/engin" ]; then
    info "Removing previous global install..."
    rm -rf "$GLOBAL_DIR/node_modules/@harms-haus/engin"
fi

# Also remove stale bin link
if [ -L "$HOME/.bun/bin/engin" ] || [ -f "$HOME/.bun/bin/engin" ]; then
    rm -f "$HOME/.bun/bin/engin"
fi

# ─── Step 3: Install globally ───────────────────────────────────────────────
info "Installing $PKG_NAME globally..."

# Bun's `bun add -g` has a bug where it appends a duplicate key to ~/package.json
# if the package already exists. Work around by removing the key first.
if [ -f "$HOME/package.json" ]; then
    # Use a temp file to safely edit JSON — remove any existing entry for our package
   DEDUPED=$(grep -v "\"$PKG_NAME\"" "$HOME/package.json" | sed "/^{$/,/^}$/{/^}/!{/^[[:space:]]*$/d}}" )
    # Simpler approach: use node/bun to clean it
    bun -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$HOME/package.json', 'utf8'));
      if (pkg.dependencies && pkg.dependencies['$PKG_NAME']) {
        delete pkg.dependencies['$PKG_NAME'];
        fs.writeFileSync('$HOME/package.json', JSON.stringify(pkg, null, 2) + '\n');
      }
    " 2>/dev/null || true
fi

bun add -g "$SCRIPT_DIR"

# ─── Step 4: Verify the `engin` command ─────────────────────────────────────
if command -v engin &>/dev/null; then
    info "✓ \`engin\` command available at $(command -v engin)"
else
    warn "\`engin\` not found in PATH. Ensure ~/.bun/bin is in your PATH."
    warn "  Add this to your shell profile:"
    warn '    export PATH="$HOME/.bun/bin:$PATH"'
fi

# ─── Step 5: Verify imports resolve for workflow scripts ─────────────────────
info "Verifying package resolves for workflow scripts..."

VERIFY_SCRIPT=$(cat <<'BUN'
// Try resolving @harms-haus/engin from a workflow-like location
import { resolve } from "node:path";
import { createRequire } from "node:module";

// Bun resolves global packages automatically, but let's verify.
try {
    const mod = await import("@harms-haus/engin");
    const exportedKeys = Object.keys(mod);
    if (exportedKeys.length === 0) {
        console.error("ERROR: Package loaded but exports are empty.");
        process.exit(1);
    }
    console.log(`OK: Found ${exportedKeys.length} exports from @harms-haus/engin`);
} catch (err: any) {
    console.error(`ERROR: Failed to import @harms-haus/engin: ${err.message}`);
    process.exit(1);
}
BUN
)

RESULT=$(bun -e "$VERIFY_SCRIPT" 2>&1) || {
    error "Package import verification failed:\n$RESULT"
}
info "✓ $RESULT"

# ─── Done ────────────────────────────────────────────────────────────────────
info "✅ $PKG_NAME installed globally."
info "   Command:  engin"
info "   Run:      engin run develop \"your task here\""
