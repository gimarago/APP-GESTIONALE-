#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 ]] || { echo 'Accedere al VPS come root.' >&2; exit 1; }
[[ -d /opt/officina/backups && ! -L /opt/officina/backups ]] || {
  echo 'Cartella /opt/officina/backups non trovata. Creare prima un backup.' >&2; exit 1;
}
[[ ! -L /usr/local/libexec && ! -L /usr/local/libexec/officina-backup-download ]] || exit 1
mkdir -p /usr/local/libexec
chown root:root /usr/local/libexec
chmod go-w /usr/local/libexec
temporary_file="$(mktemp /usr/local/libexec/.officina-backup-download.XXXXXX)"
trap 'rm -f -- "$temporary_file"' EXIT
printf '%s' '__EXPORTER_BASE64__' | base64 -d > "$temporary_file"
bash -n "$temporary_file"
chown root:root "$temporary_file"
chmod 700 "$temporary_file"
mv -f -- "$temporary_file" /usr/local/libexec/officina-backup-download
[[ ! -L /root/.ssh && ! -L /root/.ssh/authorized_keys ]] || exit 1
mkdir -p /root/.ssh
chown root:root /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chown root:root /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
readonly public_key='__PUBLIC_KEY__'
readonly key_line="restrict,command=\"/usr/local/libexec/officina-backup-download\" $public_key officina-backup-pc"
# Never reuse an existing unrestricted grant for this dedicated key.
if grep -Fq -- "$public_key" /root/.ssh/authorized_keys; then
  while IFS= read -r existing_line || [[ -n "$existing_line" ]]; do
    [[ "$existing_line" == "$key_line" ]] || {
      echo 'Questa chiave ha gia una configurazione diversa: controllare authorized_keys.' >&2; exit 1;
    }
  done < <(grep -F -- "$public_key" /root/.ssh/authorized_keys)
else
  # A leading newline also handles authorized_keys files lacking a final newline.
  printf '\n%s\n' "$key_line" >> /root/.ssh/authorized_keys
fi
echo 'Accesso dedicato ai soli backup configurato. Backup e database non modificati.'
