#!/usr/bin/env bash
# Rebuilds apps/api/assets/fonts (ST-07). Not run by CI or at render time:
# the fonts are committed, and the renderer reads them from disk only.
#
# Why static instances: satori draws a variable font at its default instance
# only, so each weight the cards use is cut from the variable font here.
# Why subsets: CJK fonts are 10-18 MB; hinting is dropped (the renderer does
# not use it) and the Korean font keeps Hangul only (Han and kana come from
# Noto Sans SC).
#
# Needs: curl, python3 with fonttools 4.60.1 (pip install fonttools==4.60.1).
# Usage: scripts/build-card-fonts.sh [workdir]   (from apps/api)
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/assets/fonts"
WORK="${1:-$(mktemp -d)}"
SRC=https://raw.githubusercontent.com/google/fonts/main/ofl
mkdir -p "$OUT" "$WORK"
cd "$WORK"

get() { # family-dir file
  local enc
  enc=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$2")
  [ -f "$2" ] || curl -fsS -o "$2" "$SRC/$1/$enc"
  curl -fsS -o "$OUT/OFL-$1.txt" "$SRC/$1/OFL.txt"
}
inst() { fonttools varLib.instancer -q "$@"; }
sub() { pyftsubset "$1" --layout-features='*' --no-hinting --unicodes="$2" --output-file="$3"; }

get literata 'Literata[opsz,wght].ttf'
inst 'Literata[opsz,wght].ttf' opsz=24 wght=400 -o "$OUT/Literata-Regular.ttf"
inst 'Literata[opsz,wght].ttf' opsz=24 wght=600 -o "$OUT/Literata-SemiBold.ttf"

get archivo 'Archivo[wdth,wght].ttf'
inst 'Archivo[wdth,wght].ttf' wdth=100 wght=400 -o "$OUT/Archivo-Regular.ttf"
inst 'Archivo[wdth,wght].ttf' wdth=100 wght=600 -o "$OUT/Archivo-SemiBold.ttf"

for fam in Arabic Hebrew; do
  dir=notosans$(echo "$fam" | tr '[:upper:]' '[:lower:]')
  get "$dir" "NotoSans$fam[wdth,wght].ttf"
  inst "NotoSans$fam[wdth,wght].ttf" wdth=100 wght=400 -o "$OUT/NotoSans$fam-Regular.ttf"
  inst "NotoSans$fam[wdth,wght].ttf" wdth=100 wght=600 -o "$OUT/NotoSans$fam-SemiBold.ttf"
done

for fam in Devanagari Bengali Tamil Telugu Kannada Malayalam Gujarati Gurmukhi Thai; do
  dir=notosans$(echo "$fam" | tr '[:upper:]' '[:lower:]')
  get "$dir" "NotoSans$fam[wdth,wght].ttf"
  inst "NotoSans$fam[wdth,wght].ttf" wdth=100 wght=400 -o "$OUT/NotoSans$fam-Regular.ttf"
done

# Owner decision on Phase 5 B: six more scripts (Phase 5 C). Google Fonts has
# no Noto Sans Tibetan; Noto Serif Tibetan is the only Tibetan Noto there.
for fam in Sinhala Oriya Ethiopic Khmer Myanmar; do
  dir=notosans$(echo "$fam" | tr '[:upper:]' '[:lower:]')
  get "$dir" "NotoSans$fam[wdth,wght].ttf"
  inst "NotoSans$fam[wdth,wght].ttf" wdth=100 wght=400 -o "$fam.ttf"
  sub "$fam.ttf" '*' "$OUT/NotoSans$fam-Regular.ttf"
done
get notoseriftibetan 'NotoSerifTibetan[wght].ttf'
inst 'NotoSerifTibetan[wght].ttf' wght=400 -o tibetan.ttf
sub tibetan.ttf '*' "$OUT/NotoSerifTibetan-Regular.ttf"

get notosanssc 'NotoSansSC[wght].ttf'
inst 'NotoSansSC[wght].ttf' wght=400 -o sc.ttf
sub sc.ttf '*' "$OUT/NotoSansSC-Regular.ttf"

get notosanskr 'NotoSansKR[wght].ttf'
inst 'NotoSansKR[wght].ttf' wght=400 -o kr.ttf
sub kr.ttf 'U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7AF,U+D7B0-D7FF' "$OUT/NotoSansKR-Hangul-Regular.ttf"

(cd "$OUT" && sha256sum ./*.ttf > SHA256SUMS)
echo "fonts written to $OUT"
