#!/usr/bin/env bash
# Deploy the app to the Launchpad server. Idempotent: safe to re-run at any time.
#
#   scripts/deploy.sh
#
# Reads PUBLIC_IP and SSH_KEY from .deploy/state.env, then:
#   1. rsyncs the source to a staging directory on the server (never node_modules, .git,
#      .deploy, out, sites, .env.local, .claude, *.wav; .env travels separately in step 2)
#   2. runs deploy/remote-apply.sh there as root, with the local .env piped in on stdin:
#      syncs staging into /opt/launchpad (owned by `launchpad`), installs .env (mode 600),
#      runs `npm ci --omit=dev` only when package-lock.json changed, installs the systemd unit,
#      installs the Caddyfile and reloads Caddy only when it changed, restarts launchpad.service
#      and waits for http://127.0.0.1:3210/api/health
#   3. prints a short status (and the last log lines if the app did not come up)
#
# First-time server setup: deploy/bootstrap.sh, then deploy/set-console-password.sh.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../deploy/lib.sh"

STAGE=launchpad-stage # relative to the ssh user's home on the server

[[ -f $ROOT/.env ]] || die "$ROOT/.env not found (the app needs it on the server)"
[[ -f $ROOT/package-lock.json ]] || die "package-lock.json not found (npm ci needs it)"
for f in Caddyfile launchpad.service remote-apply.sh; do
  [[ -f $ROOT/deploy/$f ]] || die "deploy/$f not found"
done
command -v rsync >/dev/null || die "rsync is not installed"

echo "==> $SSH_TARGET: syncing source"
rsync -rlptz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude=node_modules --exclude=.git --exclude=.DS_Store --exclude='*.wav' \
  --exclude=/.deploy --exclude=/out --exclude=/sites --exclude=/.claude \
  --exclude=/.env --exclude=/.env.local \
  "$ROOT"/ "$SSH_TARGET:$STAGE/"

echo "==> $SSH_TARGET: applying"
# stdin carries .env straight into /opt/launchpad/.env; it is never echoed or written elsewhere.
if remote "sudo bash $STAGE/deploy/remote-apply.sh $STAGE" < "$ROOT/.env"; then
  echo "==> deployed"
else
  status=$?
  echo "==> deploy FAILED (exit $status)" >&2
  exit "$status"
fi
