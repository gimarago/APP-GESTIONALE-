#!/usr/bin/env bash
# Used only through an authorized_keys forced command. Never evaluate client input.
set -euo pipefail
export PATH=/usr/bin:/bin
readonly backup_dir=/opt/officina/backups
readonly command_text="${SSH_ORIGINAL_COMMAND:-}"

fail() { echo 'Operazione di download backup non ammessa.' >&2; exit 1; }
valid_name() { [[ "$1" =~ ^officina-[0-9]{8}T[0-9]{6}Z-[0-9]+\.sqlite(\.sha256)?$ ]]; }
regular_backup() {
  valid_name "$1" && [[ -f "$backup_dir/$1" && ! -L "$backup_dir/$1" ]]
}

[[ -d "$backup_dir" && ! -L "$backup_dir" ]] || fail
case "$command_text" in
  list)
    shopt -s nullglob
    for checksum in "$backup_dir"/officina-*.sqlite.sha256; do
      name="${checksum##*/}"
      database="${name%.sha256}"
      if regular_backup "$name" && regular_backup "$database"; then
        printf '%s\n' "$database"
      fi
    done
    ;;
  get\ *)
    name="${command_text#get }"
    regular_backup "$name" || fail
    database="${name%.sha256}"
    regular_backup "$database" && regular_backup "$database.sha256" || fail
    exec /usr/bin/cat -- "$backup_dir/$name"
    ;;
  *) fail ;;
esac
