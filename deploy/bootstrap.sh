#!/usr/bin/env bash
# One-time server preparation (Amazon Linux 2023, x86_64). Safe to re-run.
#
#   ssh -i <key> ec2-user@<ip> 'sudo bash -s' < deploy/bootstrap.sh
#   deploy/set-console-password.sh        # then: creates the console basic-auth hash
#   scripts/deploy.sh                     # then: installs Caddyfile + unit, ships the app
#
# Installs Node.js 22 (distro package), Caddy (official GitHub release, SHA-512 verified),
# the `launchpad` and `caddy` system users, /opt/launchpad, and /opt/launchpad/.env.local.
# It prints no secret values.
set -euo pipefail

CADDY_VERSION=2.11.9
APP_DIR=/opt/launchpad

[[ $EUID -eq 0 ]] || { echo "run as root (sudo bash -s)" >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo "this script expects x86_64" >&2; exit 1; }

echo "== Node.js 22 (Amazon Linux package nodejs22)"
if ! rpm -q nodejs22 nodejs22-npm >/dev/null 2>&1; then
  dnf install -y -q nodejs22 nodejs22-npm
fi
node_version=$(/usr/bin/node --version)
[[ $node_version == v22.* ]] || { echo "/usr/bin/node is $node_version, expected v22" >&2; exit 1; }
echo "   node $node_version, npm $(/usr/bin/npm --version)"

echo "== Caddy $CADDY_VERSION (github.com/caddyserver/caddy release)"
if [[ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  tarball="caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  curl -fsSL --retry 3 -o "$tmp/$tarball" "$base/$tarball"
  curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  # The release publishes SHA-512 sums; refuse to install on a mismatch or a missing entry.
  (cd "$tmp" && awk -v f="$tarball" '$2 == f' checksums.txt | sha512sum -c --strict -)
  tar -xzf "$tmp/$tarball" -C "$tmp" caddy
  install -m 755 -o root -g root "$tmp/caddy" /usr/local/bin/caddy
fi
echo "   $(/usr/local/bin/caddy version | cut -d' ' -f1)"

echo "== users and directories"
getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --create-home \
  --shell /sbin/nologin --comment "Caddy web server" caddy
id launchpad >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/launchpad --create-home \
  --shell /sbin/nologin --comment "Launchpad app" launchpad
install -d -m 755 -o root -g root /etc/caddy
install -d -m 750 -o caddy -g caddy /var/lib/caddy
install -d -m 750 -o launchpad -g launchpad /var/lib/launchpad
install -d -m 755 -o launchpad -g launchpad "$APP_DIR" "$APP_DIR/sites"

echo "== $APP_DIR/.env.local (created once, never overwritten)"
if [[ ! -e $APP_DIR/.env.local ]]; then
  (
    umask 077
    {
      echo "PUBLIC_URL=https://launchpad.aloysjehwin.com"
      echo "PUBLIC_HOST=launchpad.aloysjehwin.com"
      echo "SITES_DIR=$APP_DIR/sites"
      echo "BIND_HOST=127.0.0.1"
      echo "TOOL_SECRET=$(openssl rand -hex 24)"
    } > "$APP_DIR/.env.local.tmp"
  )
  chown launchpad:launchpad "$APP_DIR/.env.local.tmp"
  mv "$APP_DIR/.env.local.tmp" "$APP_DIR/.env.local"
  echo "   created"
else
  echo "   already present, left untouched"
fi

echo "== caddy.service"
cat > /etc/systemd/system/caddy.service <<'UNIT'
# Based on the official unit: https://github.com/caddyserver/dist/blob/master/init/caddy.service
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# Enabled here, started by the first scripts/deploy.sh (it needs the Caddyfile and the auth snippet).
systemctl enable caddy >/dev/null 2>&1
echo "   caddy: $(systemctl is-enabled caddy)"
echo "bootstrap done"
