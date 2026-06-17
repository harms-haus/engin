#!/usr/bin/env bash
set -euo pipefail

# ─── Install @harms-haus/engin globally via bun (server-based workspace) ───
#
# The repo is a 5-package bun workspace. The public CLI lives in
# packages/cli (@harms-haus/engin); its `bin` runs the TypeScript entrypoint
# directly (`src/cli.ts`, `#!/usr/bin/env bun`), and its workspace deps
# (@harms-haus/engin-engine/-shared/-tui) resolve from the hoisted root
# node_modules (module resolution is relative to the script file, so it works
# regardless of the caller's cwd).
#
# Since the server-based refactor, `engin` is a client of a long-lived daemon
# (`engin server up` / auto-started by `engin run`). That daemon is spawned by
# the engine package and serves the web UI, so a correct install must verify
# not just the bin + package import, but that the daemon can actually come up.
#
# This script:
#   1. Verifies the CLI entrypoints, the daemon entrypoint, and the web bundle
#      are present (the bits the server needs, not just the CLI).
#   2. Registers @harms-haus/engin globally via `bun link` (exposes the
#      `engin` bin and makes `import { ... } from '@harms-haus/engin'`
#      resolvable from workflow scripts).
#   3. Falls back to a manual ~/.bun/bin/engin symlink if `bun link` did not
#      place the bin on PATH.
#   4. Verifies the `engin` command runs and the package imports cleanly.
#   5. Detects an orphan daemon squatting on the port with no pidfile (a
#      leftover from the pre-server-layout engin that `server down` cannot
#      find) and warns with remediation.
#   6. Smoke-tests the daemon lifecycle: `server up` → probe /health →
#      `server down`. This is the real proof the server-based install works.
#
# Usage:
#   ./install-global.sh            # (re)install / link + daemon smoke test
#   ./install-global.sh --force    # force re-link
#   ./install-global.sh --skip-smoke   # skip the daemon lifecycle smoke test

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$SCRIPT_DIR/packages/cli"
ENGINE_DIR="$SCRIPT_DIR/packages/engine"
SHARED_DIR="$SCRIPT_DIR/packages/shared"
TUI_DIR="$SCRIPT_DIR/packages/tui"
WEB_DIR="$SCRIPT_DIR/packages/web"
WEB_DIST_DIR="$SCRIPT_DIR/packages/web/dist"
PKG_NAME="@harms-haus/engin"
BUN_BIN_DIR="$HOME/.bun/bin"
DEFAULT_PORT=3619

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
command -v curl &>/dev/null || error "curl is required for the daemon smoke test."

FORCE=false
SKIP_SMOKE=false
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=true ;;
        --skip-smoke) SKIP_SMOKE=true ;;
    esac
done

# ─── Step 1: Verify the CLI + server entrypoints and web bundle ─────────────
# The CLI is only half the story now: `engin run`/`server up` spawn the daemon
# from packages/engine/src/server/server-entry.ts, and the daemon serves the
# web UI from packages/web/dist. If either is missing the install is broken in
# a way the old checks (bin + import) would never catch.
info "Verifying CLI + server entrypoints..."
[ -f "$CLI_DIR/src/cli.ts" ] || error "CLI entrypoint not found: packages/cli/src/cli.ts"
[ -f "$CLI_DIR/src/index.ts" ] || error "Public API entrypoint not found: packages/cli/src/index.ts"
[ -f "$ENGINE_DIR/src/server/server-entry.ts" ] \
    || error "Daemon entrypoint not found: packages/engine/src/server/server-entry.ts"

if [ ! -f "$WEB_DIST_DIR/index.html" ]; then
    error "Web UI bundle not found: packages/web/dist/index.html
  The daemon serves the web UI from this directory. Build it first:
      bun run --cwd packages/web build
  Then re-run ./install-global.sh."
fi
info "✓ CLI entrypoint, daemon entrypoint, and web bundle all present."

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

# ─── Step 3b: Link workspace packages for GLOBAL workflow resolution ──────
# `bun link` registers the CLI bin and a global entry under
# ~/.bun/install/global/node_modules, but a bare `import '@harms-haus/engin'`
# from a GLOBAL workflow (~/.config/engin/workflows/<name>/main.ts) does NOT
# resolve through that store — module resolution climbs the directory tree to
# the nearest ancestor node_modules, which for the default global config dir
# is ~/node_modules.
#
# The pre-workspace install-global.sh installed into ~/node_modules and left a
# real (stale) copy of @harms-haus/engin there. That copy is missing the
# workspace sibling packages (@harms-haus/engin-engine/-shared/-tui), so an
# `engin run` of a global workflow fails at startRun with:
#   "Cannot find module '@harms-haus/engin-engine'
#      from '.../~/node_modules/@harms-haus/engin/src/index.ts'"
# (the socket connects fine; only the run crashes, leaving the TUI empty).
#
# Replace any stale real copies with symlinks to the LIVE workspace packages so
# global workflow resolution always works AND always tracks the current source.
info "Linking workspace packages into ~/node_modules for global workflow resolution..."
HOME_NM="$HOME/node_modules"
mkdir -p "$HOME_NM/@harms-haus"
link_workspace_pkg () {
    # Remove a stale real directory OR an old symlink, then symlink fresh.
    rm -rf "$HOME_NM/$2"
    ln -s "$1" "$HOME_NM/$2"
}
link_workspace_pkg "$CLI_DIR"    "@harms-haus/engin"
link_workspace_pkg "$ENGINE_DIR" "@harms-haus/engin-engine"
link_workspace_pkg "$SHARED_DIR" "@harms-haus/engin-shared"
link_workspace_pkg "$TUI_DIR"    "@harms-haus/engin-tui"
link_workspace_pkg "$WEB_DIR"    "@harms-haus/engin-web"
info "✓ Workspace packages symlinked into $HOME_NM/@harms-haus/ (track the live workspace)."

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
# Run the import from a temp file directly under $HOME, mimicking a GLOBAL
# workflow at ~/.config/engin/workflows/* (resolution climbs to ~/node_modules).
# A verify run from the repo root would resolve via the workspace and HIDE a
# broken/stale global install — which is exactly the bug this catches.
info "Verifying @harms-haus/engin resolves from a global-workflow location..."

VERIFY_DIR="$(mktemp -d "$HOME/.engin-verify-XXXXXX")"
trap 'rm -rf "$VERIFY_DIR"' EXIT
cat > "$VERIFY_DIR/verify.ts" <<'BUN'
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

RESULT=$(bun "$VERIFY_DIR/verify.ts" 2>&1) || {
    error "Package import verification failed (from $VERIFY_DIR):\n$RESULT\n\nThis usually means the workspace packages are not linked into ~/node_modules/@harms-haus/ (see Step 3b)."
}
info "✓ $RESULT"

# ─── Step 7: Detect an orphan daemon on the port ────────────────────────────
# A daemon from the pre-server-layout engin can squat on :3619 with NO pidfile
# in the new global config dir. `engin server down` then fails ("No server
# pidfile found") and `engin server up` silently no-ops with pid 0 while the
# orphan keeps serving. Detect and warn (do not auto-kill — that's the user's
# call) so the install doesn't report success over a broken state.
PIDFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/engin"
PIDFILE="$PIDFILE_DIR/server.pid"
if curl -sf "http://127.0.0.1:$DEFAULT_PORT/health" >/dev/null 2>&1; then
    if [ ! -f "$PIDFILE" ]; then
        warn "An engine server is responding on port $DEFAULT_PORT but no pidfile was found at:"
        warn "  $PIDFILE"
        warn "This is usually a leftover daemon from the older (pre-server) engin layout that"
        warn "'engin server down' cannot manage. The smoke test below will skip starting a"
        warn "server to avoid a false positive. To clear it, find and stop that process, e.g.:"
        warn "    lsof -ti tcp:$DEFAULT_PORT | xargs -r kill"
        warn "    # then: ./install-global.sh"
        ORPHAN_DETECTED=true
    else
        ORPHAN_DETECTED=false
    fi
else
    ORPHAN_DETECTED=false
fi

# ─── Step 8: Smoke-test the daemon lifecycle ────────────────────────────────
# The whole point of the server-based transition is that the daemon comes up,
# answers /health, and can be torn down. This is the one check that actually
# exercises the spawn path; without it a broken daemon would pass "install".
if [ "$SKIP_SMOKE" = true ]; then
    info "Skipping daemon smoke test (--skip-smoke)."
elif [ "${ORPHAN_DETECTED:-false}" = true ]; then
    warn "Skipping daemon smoke test because an orphan is squatting on port $DEFAULT_PORT (see above)."
else
    info "Smoke-testing daemon lifecycle (server up → /health → server down)..."

    # If a managed server is already up, leave it running and just verify it
    # responds — don't tear down a server the user is actively using.
    PREEXISTING=false
    if curl -sf "http://127.0.0.1:$DEFAULT_PORT/health" >/dev/null 2>&1; then
        PREEXISTING=true
    fi

    if [ "$PREEXISTING" = true ]; then
        info "✓ A managed server is already up on port $DEFAULT_PORT; /health responded. (Leaving it running.)"
    else
        if ! engin server up >/dev/null 2>&1; then
            error "Daemon failed to start (engin server up). Check logs: $PIDFILE_DIR/logs/server.log"
        fi

        # Probe /health with retries (the daemon's own readiness loop already
        # waited, but a short retry here makes a flaky CI host fail loudly
        # instead of silently).
        HEALTH_OK=false
        for _ in $(seq 1 20); do
            if curl -sf "http://127.0.0.1:$DEFAULT_PORT/health" >/dev/null 2>&1; then
                HEALTH_OK=true
                break
            fi
            sleep 0.5
        done
        if [ "$HEALTH_OK" != true ]; then
            error "Daemon started but /health never responded on port $DEFAULT_PORT.
  Check logs: $PIDFILE_DIR/logs/server.log"
        fi
        info "✓ /health responded from the freshly-started daemon."

        # Tear down the server we started so the install leaves a clean state.
        if ! engin server down -y >/dev/null 2>&1; then
            warn "'engin server down' did not report success; the daemon may still be running."
        else
            info "✓ Daemon stopped cleanly."
        fi
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────
info "✅ $PKG_NAME linked globally."
info "   Command:  engin"
info "   Run:      engin run develop \"your task here\""
info "   Server:   engin server up   (then \`engin run\` or open the web UI)"
