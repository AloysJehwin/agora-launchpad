#!/usr/bin/env bash
# Creates (or rotates) the operator console password. Run from your machine:
#
#   deploy/set-console-password.sh
#
# The password is generated on the server and hashed there with `caddy hash-password`. Only the
# hash is stored on the server (/etc/caddy/console-auth.caddy, imported by the Caddyfile); the
# plaintext is piped over ssh straight into .deploy/console-password.txt (mode 600, gitignored)
# and is never printed.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT=$ROOT/.deploy/console-password.txt
umask 077
tmp=$(mktemp "$OUT.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# stdout of the remote command is the plaintext and nothing else.
remote 'sudo bash -s' > "$tmp" <<'REMOTE'
set -euo pipefail
exec 3>&1 1>&2
password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')
password=${password:0:32}
[[ ${#password} -eq 32 ]] || { echo "could not generate a password" >&2; exit 1; }
hash=$(printf '%s' "$password" | /usr/local/bin/caddy hash-password)
[[ $hash == '$2'* ]] || { echo "caddy hash-password returned no bcrypt hash" >&2; exit 1; }
umask 027
printf 'basic_auth {\n\toperator %s\n}\n' "$hash" > /etc/caddy/console-auth.caddy.tmp
chown root:caddy /etc/caddy/console-auth.caddy.tmp
mv -f /etc/caddy/console-auth.caddy.tmp /etc/caddy/console-auth.caddy
if systemctl is-active --quiet caddy; then systemctl reload caddy; fi
printf '%s\n' "$password" >&3
REMOTE

[[ -s $tmp ]] || die "no password came back from the server"
chmod 600 "$tmp"
mv -f "$tmp" "$OUT"
trap - EXIT
echo "console password saved to $OUT (user: operator)"
