#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "$#" -lt 2 || "$2" != '--confirm-restore' || "$#" -gt 3 ]]; then
  echo 'Uso: bash deploy/restore.sh /percorso/backup.sqlite --confirm-restore [--skip-safety-backup]' >&2
  echo 'Sostituisce tutti i dati e gli utenti correnti con quelli del backup.' >&2
  exit 2
fi
if [[ "$#" == 3 && "$3" != '--skip-safety-backup' ]]; then exit 2; fi
source_file="$(realpath -e -- "$1")"
if [[ ! -f "$source_file" || ! -f "$source_file.sha256" ]]; then
  echo 'Servono il backup e il file .sha256 prodotto da backup.sh.' >&2
  exit 2
fi
expected="$(awk 'NR == 1 {print $1}' "$source_file.sha256")"
# Private host directory protects a temporary copy; mode 644 on the FILE lets
# UID 1000 read its individual read-only bind mount inside the container.
staging_dir="$(mktemp -d "$project_dir/.restore-XXXXXX")"
trap 'rm -f -- "$staging_dir/source.sqlite"; rmdir -- "$staging_dir"' EXIT
cp -- "$source_file" "$staging_dir/source.sqlite"
chmod 644 -- "$staging_dir/source.sqlite"
actual="$(sha256sum -- "$staging_dir/source.sqlite")"
actual="${actual%% *}"
if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ || "${actual,,}" != "${expected,,}" ]]; then
  echo 'Checksum non valido: ripristino annullato.' >&2
  exit 1
fi
cd -- "$project_dir"
exec 9>"$project_dir/.maintenance.lock"
flock -n 9 || { echo 'Manutenzione gia in corso.' >&2; exit 1; }
if [[ "${3:-}" != '--skip-safety-backup' ]]; then
  OFFICINA_MAINTENANCE_LOCK_HELD=1 bash deploy/backup.sh
fi
pec_was_running=0
if docker compose --profile pec ps --status running --services | grep -Fxq pec; then
  pec_was_running=1
  docker compose --profile pec stop pec
fi
docker compose stop app
if ! docker compose run --rm --no-deps -T --volume "$staging_dir/source.sqlite:/restore/source.sqlite:ro" app node server/cli.mjs restore /restore/source.sqlite; then
  echo 'Ripristino fallito. App e ricezione PEC lasciate ferme: controllare i log e il backup prima di riavviarle.' >&2
  exit 1
fi
docker compose up -d --wait app
docker compose up -d caddy
if [[ "$pec_was_running" == 1 ]]; then docker compose --profile pec up -d pec; fi
echo 'Ripristino completato. Chiudere e riaprire tutte le sessioni prima di riprendere il lavoro.'
