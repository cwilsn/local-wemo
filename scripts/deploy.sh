#!/usr/bin/env bash
set -euo pipefail

deploy_target=${DEPLOY_TARGET:-corey@192.168.4.37}
deploy_dir=${DEPLOY_DIR:-/home/corey/local-wemo}
node_bin_dir=${DEPLOY_NODE_BIN_DIR:-/home/corey/.local/node-v24.21.0/bin}
service=local-wemo

cd "$(dirname "$0")/.."

echo 'Checking and testing the local working tree...'
npm run check
npm test

echo "Preparing ${deploy_target}:${deploy_dir}..."
stage=$(ssh -o BatchMode=yes "$deploy_target" bash -s -- "$deploy_dir" "$node_bin_dir" <<'REMOTE'
set -euo pipefail
deploy_dir=$1
node_bin_dir=$2
test -x "$node_bin_dir/node"
test -x "$node_bin_dir/npm"
mkdir -p "$deploy_dir"
mktemp -d "$deploy_dir/.deploy-stage.XXXXXXXX"
REMOTE
)

cleanup() {
  if [[ -n ${stage:-} ]]; then
    ssh -o BatchMode=yes "$deploy_target" bash -s -- "$deploy_dir" "$stage" <<'REMOTE' || true
set -euo pipefail
deploy_dir=$1
stage=$2
[[ "$stage" == "$deploy_dir"/.deploy-stage.* ]] || exit 1
rm -rf -- "$stage"
REMOTE
  fi
}
trap cleanup EXIT

# Only release files are copied; the Pi's .env and saved schedules stay in place.
rsync -az --exclude='.DS_Store' --exclude='._*'   .env.example package.json package-lock.json src test scripts public   "$deploy_target:$stage/"

echo 'Installing dependencies on the Pi...'
ssh -o BatchMode=yes "$deploy_target" bash -s -- "$deploy_dir" "$stage" "$node_bin_dir" <<'REMOTE'
set -euo pipefail
deploy_dir=$1
stage=$2
node_bin_dir=$3
export PATH="$node_bin_dir:$PATH"
cd "$stage"
if cmp -s package-lock.json "$deploy_dir/package-lock.json" && test -d "$deploy_dir/node_modules"; then
  cp -a "$deploy_dir/node_modules" .
else
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
fi
node --test test/*.test.js
REMOTE

echo 'Activating Local Wemo...'
ssh -o BatchMode=yes "$deploy_target" bash -s -- "$deploy_dir" "$stage" "$node_bin_dir" "$service" <<'REMOTE'
set -euo pipefail
deploy_dir=$1
stage=$2
node_bin_dir=$3
service=$4
export PATH="$node_bin_dir:$PATH"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/$service.service"
backup=$(mktemp -d "$deploy_dir/.deploy-backup.XXXXXXXX")
items=(.env.example package.json package-lock.json src test scripts public node_modules)
switched=()
was_active=false
was_enabled=false
systemctl --user is-active --quiet "$service" && was_active=true
systemctl --user is-enabled --quiet "$service" 2>/dev/null && was_enabled=true
if test -f "$unit"; then cp "$unit" "$backup/previous.service"; fi

rollback() {
  echo 'Deployment failed; restoring the previous release...' >&2
  trap - ERR
  set +e
  systemctl --user stop "$service"
  for item in "${switched[@]}"; do
    rm -rf -- "$deploy_dir/$item"
    if test -e "$backup/$item"; then mv -- "$backup/$item" "$deploy_dir/$item"; fi
  done
  if test -f "$backup/previous.service"; then
    cp "$backup/previous.service" "$unit"
  else
    rm -f -- "$unit"
  fi
  systemctl --user daemon-reload
  if "$was_enabled"; then systemctl --user enable "$service"; else systemctl --user disable "$service" 2>/dev/null; fi
  if "$was_active"; then systemctl --user start "$service"; fi
  echo "Previous release retained in $backup" >&2
}
trap rollback ERR

if "$was_active"; then systemctl --user stop "$service"; fi
for item in "${items[@]}"; do
  if test -e "$deploy_dir/$item"; then mv -- "$deploy_dir/$item" "$backup/$item"; fi
  switched+=("$item")
  mv -- "$stage/$item" "$deploy_dir/$item"
done
if ! test -f "$deploy_dir/.env"; then
  cp "$deploy_dir/.env.example" "$deploy_dir/.env"
  chmod 600 "$deploy_dir/.env"
fi
mkdir -p "$unit_dir"
cat > "$unit" <<UNIT
[Unit]
Description=Local Wemo lights and daily schedule
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$deploy_dir
ExecStart=$node_bin_dir/node $deploy_dir/src/server.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$service"

port=$(node --input-type=module - "$deploy_dir" <<'NODE'
import { loadEnvFile } from 'node:process';
loadEnvFile(process.argv[2] + '/.env');
console.log(process.env.PORT || '8081');
NODE
)
healthy=false
for attempt in {1..15}; do
  if systemctl --user is-active --quiet "$service" &&
     curl -fsS "http://127.0.0.1:$port/api/health" -o /dev/null 2>/dev/null &&
     curl -fsS "http://127.0.0.1:$port/" 2>/dev/null | cmp - "$deploy_dir/public/index.html" &&
     curl -fsS "http://127.0.0.1:$port/app.js" 2>/dev/null | cmp - "$deploy_dir/public/app.js" &&
     curl -fsS "http://127.0.0.1:$port/style.css" 2>/dev/null | cmp - "$deploy_dir/public/style.css"; then
    healthy=true
    break
  fi
  sleep 1
done
test "$healthy" = true

trap - ERR
rm -rf -- "$backup"
echo "Deployed successfully. $service is active on port $port."
REMOTE
