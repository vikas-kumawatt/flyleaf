#!/usr/bin/env bash
# Prints KEY='value' for each KEY given, after sourcing FILE in this clean
# shell, so values built from other values ("https://${FLYLEAF_HOST}") come
# out literal. configure-env.sh runs it under `env -i`; not for direct use.
#
#   render-env.sh FILE KEY...
set -euo pipefail
file="$1"; shift
set -a
# shellcheck disable=SC1090
. "$file"
set +a
bad=""
for k in "$@"; do
  v="${!k-}"
  [[ "$v" =~ \<[^\>@]*\> ]] && bad="$bad $k"
  if [[ "$v" == *"'"* || "$v" == *$'\n'* ]]; then
    echo "$k: a value may not contain a single quote or a newline" >&2
    exit 1
  fi
  printf "%s='%s'\n" "$k" "$v"
done
[[ -z "$bad" ]] || { echo "placeholders left in:$bad" >&2; exit 1; }
