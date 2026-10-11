#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_dir"
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo 'Uso: bash deploy/user.sh add NOME [admin|operator|viewer]' >&2
  echo '     bash deploy/user.sh password NOME' >&2
  echo '     bash deploy/user.sh email NOME indirizzo@example.com' >&2
  echo '     bash deploy/user.sh email-clear NOME' >&2
  exit 2
fi
action="$1"
username="$2"
case "$action" in
  add) args=(user-add "$username" --role "${3:-operator}") ;;
  password) args=(user-password "$username") ;;
  email)
    if [[ "$#" -ne 3 ]]; then echo 'Indicare l’indirizzo email.' >&2; exit 2; fi
    docker compose exec -T app node server/cli.mjs user-email "$username" "$3"
    exit
    ;;
  email-clear)
    if [[ "$#" -ne 2 ]]; then echo 'Uso: bash deploy/user.sh email-clear NOME' >&2; exit 2; fi
    docker compose exec -T app node server/cli.mjs user-email-clear "$username"
    exit
    ;;
  *) echo 'Azione non valida.' >&2; exit 2 ;;
esac
IFS= read -r -s -p 'Password: ' password
printf '\n'
IFS= read -r -s -p 'Ripeti password: ' confirmation
printf '\n'
if [[ "$password" != "$confirmation" ]]; then
  unset password confirmation
  echo 'Le password non coincidono.' >&2
  exit 2
fi
# A pipe avoids credentials in shell history, argv, Compose config and env.
printf '%s\n' "$password" | docker compose exec -T app node server/cli.mjs "${args[@]}"
unset password confirmation
