#!/usr/bin/env bash
# Sauvegarde : pg_dump (plain) des schémas public, private, auth -> gzip -> age (clé publique du dépôt).
# Usage : KLIR_BACKUP_DB_URL=... KLIR_BACKUP_PROJECT_REF=<ref> backup.sh <dossier-sortie>
# Le fichier en clair n'est jamais écrit sur disque : le flux est chiffré à la volée.
set -euo pipefail
out=${1:?dossier sortie}
: "${KLIR_BACKUP_DB_URL:?KLIR_BACKUP_DB_URL absent}"; : "${KLIR_BACKUP_PROJECT_REF:?KLIR_BACKUP_PROJECT_REF absent}"
case "$KLIR_BACKUP_DB_URL" in *"$KLIR_BACKUP_PROJECT_REF"*) ;; *) echo "backup: l'URL ne désigne pas le projet $KLIR_BACKUP_PROJECT_REF" >&2; exit 2;; esac
here=$(cd "$(dirname "$0")" && pwd)
recipient=$(cat "$here/age-recipient.txt")
mkdir -p "$out"; stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$out/klirprospect-${KLIR_BACKUP_PROJECT_REF}-${stamp}.sql.gz.age"
pg_dump "$KLIR_BACKUP_DB_URL" --format=plain --no-owner --no-comments \
  --schema=public --schema=private --schema=auth \
  | gzip -9 | age -r "$recipient" -o "$file"
( cd "$out" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
echo "backup: $(basename "$file") $(stat -c %s "$file") octets"
