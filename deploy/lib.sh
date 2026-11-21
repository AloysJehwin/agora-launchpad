# shellcheck shell=bash
# Shared by scripts/deploy.sh and deploy/set-console-password.sh (sourced, not executed).
# Reads the target host and SSH key from .deploy/state.env and defines `remote`.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE_FILE=$ROOT/.deploy/state.env

die() { echo "error: $*" >&2; exit 1; }

# state_value KEY -> the value of KEY in state.env (the file is parsed, never sourced).
state_value() {
  local value
  value=$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1=//p" "$STATE_FILE" | tail -n 1)
  value=${value%$'\r'}
  value=${value#[\"\']}
  value=${value%[\"\']}
  printf '%s' "$value"
}

[[ -r $STATE_FILE ]] || die "$STATE_FILE not found"
PUBLIC_IP=$(state_value PUBLIC_IP)
SSH_KEY=$(state_value SSH_KEY)
SSH_USER=$(state_value SSH_USER)
SSH_USER=${SSH_USER:-ec2-user}
SSH_KEY=${SSH_KEY/#\~/$HOME}
[[ -n $PUBLIC_IP ]] || die "PUBLIC_IP is missing from $STATE_FILE"
[[ $SSH_KEY != *[[:space:]]* ]] || die "SSH_KEY must not contain whitespace (rsync -e cannot quote it)"
[[ -r $SSH_KEY ]] || die "SSH key '$SSH_KEY' (SSH_KEY in $STATE_FILE) is not readable"

SSH_TARGET=$SSH_USER@$PUBLIC_IP
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15
  -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15)

# shellcheck disable=SC2029  # arguments are meant to expand locally
remote() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
