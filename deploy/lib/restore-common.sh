# shellcheck shell=bash
# Shared by backup/restore-drill.sh and backup/restore-full.sh. Sourced after
# lib/common.sh, never run.

# The newest backup in $BACKUP_REMOTE/<folder>, downloaded to $2. Prints its path.
fetch_newest() {
  local folder="$1" dest="$2" name
  name="$(rclone lsf --files-only "$BACKUP_REMOTE/$folder" | grep '^flyleaf-.*\.tar\.age$' | sort | tail -1)"
  [[ -n "$name" ]] || die "no backups in $BACKUP_REMOTE/$folder"
  rclone copyto "$BACKUP_REMOTE/$folder/$name" "$dest/$name"
  printf '%s\n' "$dest/$name"
}

# Decrypts and unpacks $1 into $2, then checks every file against the manifest.
unpack_backup() {
  local file="$1" dir="$2" key="${BACKUP_AGE_KEY:-$FLYLEAF_ETC/backup.agekey}"
  [[ -r "$key" ]] || die "no private key at $key: restore it from your password manager first (docs/deploy.md)"
  mkdir -p "$dir"
  age -d -i "$key" "$file" | tar --zstd -x -C "$dir" -f -
  [[ "$(manifest_field "$dir/manifest.txt" format)" == flyleaf-backup-1 ]] || die "$file: not a flyleaf-backup-1 archive"
  local f want have
  while read -r _ f want; do
    have="$(sha256sum "$dir/$f" | cut -d' ' -f1)"
    [[ "$have" == "$want" ]] || die "$f is damaged inside $file (sha256 $have, manifest $want)"
  done < <(awk '$1 == "sha256"' "$dir/manifest.txt")
  chmod -R a+rX "$dir"   # psql and pg_restore in the container read it
}

manifest_field() {
  awk -v k="$2" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' "$1"
}

# Header of a delta CSV: its column list, as written by backup.sh.
csv_columns() { head -1 "$1" | tr -d '\r'; }

# Prints one "SELECT '<constraint>', count(*) ..." per foreign key in database
# $1, each counting the rows that break it. With "user-only", only foreign
# keys between two non-catalog tables. Run the output against any database
# with the same tables (the drill's scratch copy has no constraints at all,
# so the definitions come from the live database).
fk_check_queries() {
  local db="$1" scope="${2:-all}" filter=""
  if [[ "$scope" == user-only ]]; then
    local list; list="$(catalog_tables all | sed "s/.*/'&'/" | paste -sd, -)"
    filter="AND cc.relname NOT IN ($list) AND pc.relname NOT IN ($list)"
  fi
  pg_value "$db" "
    SELECT format(
      'SELECT %L, count(*) FROM public.%I c WHERE %s AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE %s);',
      con.conname, cc.relname,
      (SELECT string_agg(format('c.%I IS NOT NULL', a.attname), ' AND ')
         FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k),
      pc.relname,
      (SELECT string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' AND ')
         FROM unnest(con.conkey, con.confkey) AS u(ck, fk)
         JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.ck
         JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = u.fk))
    FROM pg_constraint con
    JOIN pg_class cc ON cc.oid = con.conrelid
    JOIN pg_class pc ON pc.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = cc.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public' $filter
    ORDER BY 1"
}

# Runs the checks from fk_check_queries against database $1 (queries on
# stdin). Prints the broken ones; returns 1 if any.
run_fk_checks() {
  local db="$1" broken
  broken="$(pg -d "$db" -Atq -F ' ' | awk '$2 != 0')"
  if [[ -n "$broken" ]]; then
    printf '  broken foreign key: %s rows\n' "$broken" >&2
    return 1
  fi
}

# Compares database $2 with manifest $1: "count" lines (user tables), and
# "checksum" lines. Prints a table; returns 1 on any difference, or if not
# every line was compared (a loop that stops early must not pass).
compare_with_manifest() {
  local manifest="$1" db="$2" bad=0 seen=0 kind table expected actual
  printf '  %-28s %12s %12s\n' table backup restored >&2
  while read -r kind table expected; do
    case "$kind" in
      count) actual="$(pg_value "$db" "SELECT count(*) FROM public.\"$table\"")" ;;
      checksum) actual="$(pg_value "$db" "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM public.\"$table\" x")" ;;
      *) continue ;;
    esac
    seen=$((seen + 1))
    if [[ "$actual" == "$expected" ]]; then
      [[ "$kind" == count ]] && printf '  %-28s %12s %12s\n' "$table" "$expected" "$actual" >&2
    else
      bad=1
      printf '  %-28s %12s %12s  MISMATCH (%s)\n' "$table" "${expected:0:12}" "${actual:0:12}" "$kind" >&2
    fi
  done < <(awk '$1 == "count" || $1 == "checksum"' "$manifest")
  local want; want="$(awk '$1 == "count" || $1 == "checksum"' "$manifest" | wc -l)"
  if [[ "$seen" != "$want" ]]; then
    printf '  compared only %s of %s manifest lines\n' "$seen" "$want" >&2
    return 1
  fi
  ((bad)) || printf '  %s counts and %s content checksums identical\n' \
    "$(awk '$1 == "count"' "$manifest" | wc -l)" "$(awk '$1 == "checksum"' "$manifest" | wc -l)" >&2
  return "$bad"
}
