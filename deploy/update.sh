#!/usr/bin/env bash
# Build locally, ship to the Droplet, install + restart there.
# We install prod node_modules on the Droplet because some deps (better-sqlite3
# in Phase 2, ssh2 native bits) have platform-specific binaries that wouldn't
# survive a macOS->Linux rsync.
#
# Usage:
#   DROPLET_HOST=root@1.2.3.4 ./deploy/update.sh
#
# Optional:
#   APP_DIR  (default /var/lib/conduit/app)
#   WEB_DIR  (default /var/www/conduit)

set -euo pipefail

if [[ -z "${DROPLET_HOST:-}" ]]; then
	echo "DROPLET_HOST is required (e.g. root@1.2.3.4)" >&2
	exit 1
fi
# Optional: only needed if you want a token baked into the static bundle (legacy
# dev shortcut). Phase 2 uses the login screen instead.
VITE_API_TOKEN="${VITE_API_TOKEN:-}"

APP_DIR="${APP_DIR:-/var/lib/conduit/app}"
WEB_DIR="${WEB_DIR:-/var/www/conduit}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Local: install + build"
npm ci
VITE_API_TOKEN="$VITE_API_TOKEN" npm run build --workspaces --if-present

echo "==> Remote: ensure target dirs exist"
ssh "$DROPLET_HOST" "mkdir -p $APP_DIR/services/middleman $APP_DIR/packages/shared $APP_DIR/packages/client $WEB_DIR"

echo "==> Remote: ship sources needed by the runtime"
# Top-level package.json + lock so we can run a clean workspace install on the Droplet.
rsync -az package.json package-lock.json "$DROPLET_HOST:$APP_DIR/"

# Middleman: only ship the build output + package.json + .npmrc-like files.
rsync -az --delete \
	services/middleman/dist/ \
	"$DROPLET_HOST:$APP_DIR/services/middleman/dist/"
rsync -az \
	services/middleman/package.json \
	"$DROPLET_HOST:$APP_DIR/services/middleman/"

# Shared: only types are imported at runtime (erased), but we still ship the
# package.json so npm workspace resolution works.
rsync -az --delete \
	packages/shared/src/ \
	"$DROPLET_HOST:$APP_DIR/packages/shared/src/"
rsync -az \
	packages/shared/package.json \
	"$DROPLET_HOST:$APP_DIR/packages/shared/"

# Client: not used by the middleman runtime, but the web bundle inlined it.
# We still ship the package.json so workspace resolution stays consistent.
rsync -az --delete \
	packages/client/src/ \
	"$DROPLET_HOST:$APP_DIR/packages/client/src/"
rsync -az \
	packages/client/package.json \
	"$DROPLET_HOST:$APP_DIR/packages/client/"

echo "==> Remote: install production node_modules"
ssh "$DROPLET_HOST" "cd $APP_DIR && npm ci --omit=dev"

echo "==> Remote: sync web static"
rsync -az --delete \
	services/web/dist/ \
	"$DROPLET_HOST:$WEB_DIR/"

echo "==> Remote: chown + restart"
ssh "$DROPLET_HOST" "chown -R conduit:conduit $APP_DIR $WEB_DIR && systemctl restart conduit.service && systemctl reload caddy"

echo "==> Done. Tail logs with: ssh $DROPLET_HOST journalctl -u conduit.service -f"
