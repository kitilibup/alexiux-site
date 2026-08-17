#!/usr/bin/env bash
# Render every mirrored page twice - once from the local copy, once from the
# live site - and compare the resulting screenshots byte for byte.
#
# Requires the local server to be running:
#   python3 -m http.server 8099 --bind 127.0.0.1
#
# Usage: tools/visual-diff.sh [output-dir] [width]

set -uo pipefail

CHROME="${CHROME:-$HOME/dev/.pw-browsers/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium}"
LOCAL_BASE="${LOCAL_BASE:-http://127.0.0.1:8099/mirror/dist}"
LIVE_BASE="${LIVE_BASE:-https://alexiux.com}"
OUT="${1:-./visual-diff}"
WIDTH="${2:-1440}"
HEIGHT="${HEIGHT:-1000}"

PAGES=(
  "index:/"
  "about:/about"
  "work:/work"
  "collaborate:/collaborate"
  "project/campy:/project/campy"
  "project/connect-project-transmixr:/project/connect-project-transmixr"
  "project/feedback:/project/feedback"
  "project/kombain-by:/project/kombain-by"
  "project/mercedes-me-app:/project/mercedes-me-app"
  "project/musicians-page:/project/musicians-page"
  "project/neighbour:/project/neighbour"
  "project/runorugs:/project/runorugs"
)

shot() {
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="$WIDTH,$HEIGHT" \
    --virtual-time-budget=40000 --screenshot="$2" "$1" >/dev/null 2>&1
}

mkdir -p "$OUT"
same=0; diff=0; fail=0

printf "Comparing %d pages at %spx wide\n\n" "${#PAGES[@]}" "$WIDTH"

for entry in "${PAGES[@]}"; do
  slug="${entry%%:*}"
  path="${entry#*:}"
  flat="${slug//\//-}"

  shot "$LOCAL_BASE/$slug.html" "$OUT/$flat.local.png"
  shot "$LIVE_BASE$path"        "$OUT/$flat.live.png"

  if [[ ! -s "$OUT/$flat.local.png" || ! -s "$OUT/$flat.live.png" ]]; then
    printf "  FAIL   %-34s (screenshot missing)\n" "$slug"; fail=$((fail+1)); continue
  fi

  if cmp -s "$OUT/$flat.local.png" "$OUT/$flat.live.png"; then
    printf "  match  %-34s\n" "$slug"
    rm -f "$OUT/$flat.local.png" "$OUT/$flat.live.png"
    same=$((same+1))
  else
    lsz=$(wc -c <"$OUT/$flat.local.png"); rsz=$(wc -c <"$OUT/$flat.live.png")
    printf "  DIFF   %-34s local=%sB live=%sB\n" "$slug" "$lsz" "$rsz"
    diff=$((diff+1))
  fi
done

printf "\n  %d identical, %d differing, %d failed\n" "$same" "$diff" "$fail"
[[ $diff -gt 0 ]] && printf "  Differing pairs kept in %s for inspection.\n" "$OUT"
exit $(( diff + fail > 0 ? 1 : 0 ))
