#!/usr/bin/env bash
# Runs ON THE SERVER as root, started by scripts/deploy.sh after it has rsynced the source into
# the staging directory. Usage: remote-apply.sh <staging dir>, with the app's .env on stdin.
# Idempotent. Prints no secret values.
set -euo pipefail

STAGE=${1:?usage: remote-apply.sh <staging dir>}
APP_DIR=/opt/launchpad
APP_USER=launchpad
HEALTH_URL=http://127.0.0.1:3210/api/health
HEALTH_TIMEOUT=45
CADDY=/usr/local/bin/caddy
AUTH_SNIPPET=/etc/caddy/console-auth.caddy

[[ $EUID -eq 0 ]] || { echo "remote-apply.sh must run as root" >&2; exit 1; }
[[ -f $STAGE/package.json && -f $STAGE/deploy/Caddyfile && -f $STAGE/deploy/launchpad.service ]] ||
  { echo "staging directory $STAGE is incomplete" >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 && [[ -x $CADDY && -x /usr/bin/node ]] ||
  { echo "server is not prepared: run deploy/bootstrap.sh first" >&2; exit 1; }
[[ -s $AUTH_SNIPPET ]] ||
  { echo "$AUTH_SNIPPET is missing: run deploy/set-console-password.sh first" >&2; exit 1; }

step() { echo "-- $*"; }

step "source -> $APP_DIR"
# Server-owned paths are protected from --delete: dependencies, generated sites, both env files.
rsync -rlpt --delete --chown="$APP_USER:$APP_USER" \
  --exclude=/node_modules --exclude=/sites --exclude=/.env --exclude=/.env.local \
  "$STAGE"/ "$APP_DIR"/
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/sites"

step ".env (mode 600, $APP_USER)"
(
  umask 077
  cat > "$APP_DIR/.env.tmp"
)
[[ -s $APP_DIR/.env.tmp ]] || { rm -f "$APP_DIR/.env.tmp"; echo "no .env received on stdin" >&2; exit 1; }
chown "$APP_USER:$APP_USER" "$APP_DIR/.env.tmp"
mv -f "$APP_DIR/.env.tmp" "$APP_DIR/.env"
[[ -f $APP_DIR/.env.local ]] || echo "   warning: $APP_DIR/.env.local is missing (deploy/bootstrap.sh creates it)"

step "dependencies"
lock_sum=$(sha256sum "$APP_DIR/package-lock.json" | cut -d' ' -f1)
# The marker lives inside node_modules, so a wiped node_modules also forces a reinstall.
marker=$APP_DIR/node_modules/.deployed-lock-sha256
if [[ -f $marker && $(<"$marker") == "$lock_sum" ]]; then
  echo "   package-lock.json unchanged, skipping npm ci"
else
  echo "   package-lock.json changed, running npm ci --omit=dev"
  (cd "$APP_DIR" && sudo -H -u "$APP_USER" /usr/bin/npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)
  echo "$lock_sum" > "$marker"
  chown "$APP_USER:$APP_USER" "$marker"
fi

step "launchpad.service"
if ! cmp -s "$STAGE/deploy/launchpad.service" /etc/systemd/system/launchpad.service; then
  install -m 644 -o root -g root "$STAGE/deploy/launchpad.service" /etc/systemd/system/launchpad.service
  systemctl daemon-reload
  echo "   unit installed"
else
  echo "   unit unchanged"
fi
systemctl enable launchpad >/dev/null 2>&1

step "Caddyfile"
if ! cmp -s "$STAGE/deploy/Caddyfile" /etc/caddy/Caddyfile; then
  # Validate before replacing, so a broken Caddyfile never takes the site down.
  if ! validation=$("$CADDY" validate --adapter caddyfile --config "$STAGE/deploy/Caddyfile" 2>&1); then
    echo "$validation" | tail -n 15 >&2
    echo "Caddyfile is invalid; the installed one was left untouched" >&2
    exit 1
  fi
  install -m 644 -o root -g root "$STAGE/deploy/Caddyfile" /etc/caddy/Caddyfile
  echo "   Caddyfile changed, installed"
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
    echo "   Caddy reloaded"
  fi
else
  echo "   Caddyfile unchanged, no reload"
fi
systemctl enable caddy >/dev/null 2>&1
if ! systemctl is-active --quiet caddy; then
  systemctl start caddy
  echo "   Caddy started"
fi

step "restart launchpad and wait for $HEALTH_URL"
systemctl restart launchpad
healthy=0
for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
  if curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done

echo
echo "launchpad: $(systemctl is-active launchpad || true) ($(systemctl is-enabled launchpad 2>/dev/null || true))" \
  " caddy: $(systemctl is-active caddy || true) ($(systemctl is-enabled caddy 2>/dev/null || true))"
if ((healthy)); then
  echo "health:    OK after ${i}s ($HEALTH_URL)"
  echo "listening: $(ss -Hltn '( sport = :3210 or sport = :3211 )' | awk '{print $4}' | sort -u | paste -sd' ' -)"
else
  echo "health:    FAILED, no answer from $HEALTH_URL within ${HEALTH_TIMEOUT}s" >&2
  echo "--- last log lines (journalctl -u launchpad) ---" >&2
  journalctl -u launchpad -n 25 --no-pager -o cat >&2 || true
  exit 1
fi
