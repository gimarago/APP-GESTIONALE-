#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_dir"
retention_days="${RETENTION_DAYS:-30}"
if [[ ! "$retention_days" =~ ^[1-9][0-9]{0,3}$ ]] || ((retention_days > 3650)); then
  echo 'RETENTION_DAYS deve essere compreso tra 1 e 3650.' >&2
  exit 2
fi
backup_dir="$project_dir/backups"
mkdir -p -- "$backup_dir"
chmod 700 -- "$backup_dir"
# Prevent overlapping scheduled copies or concurrent restore.
exec 9>"$project_dir/.maintenance.lock"
if [[ "${OFFICINA_MAINTENANCE_LOCK_HELD:-0}" != 1 ]]; then
  flock -n 9 || { echo 'Manutenzione gia in corso.' >&2; exit 1; }
fi
name="officina-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"
partial="$backup_dir/$name.partial"
trap 'rm -f -- "$partial"' EXIT
docker compose exec -T app node server/cli.mjs backup "/backups/$name"
docker compose cp "app:/backups/$name" "$partial"
chmod 600 -- "$partial"
mv -- "$partial" "$backup_dir/$name"
(cd -- "$backup_dir" && sha256sum -- "$name" > "$name.sha256")
# Retention runs only after a new online backup was exported successfully.
docker compose exec -T app node deploy/prune-backups.mjs "$retention_days"
find "$backup_dir" -maxdepth 1 -type f \( -name 'officina-*.sqlite' -o -name 'officina-*.sqlite.sha256' \) -mtime "+$retention_days" -delete
echo "Backup esportato: $backup_dir/$name"
echo 'Copiare questo file e il suo .sha256 su storage esterno cifrato.'
