#!/usr/bin/env bash
# PNG (przezroczyste) i PDF z plików wzorcowych SVG. Wymaga rsvg-convert (brew install librsvg).
# Uruchomienie z katalogu docs/brand/logo:  ./zrodla/eksport.sh
set -euo pipefail
cd "$(dirname "$0")/../zestaw"
mkdir -p png pdf
for f in svg/faktway-logo*.svg svg/faktway-napis*.svg; do
  n=$(basename "$f" .svg)
  rsvg-convert -w 1200 "$f" -o "png/$n-1200.png"
  rsvg-convert -w 2400 "$f" -o "png/$n-2400.png"
done
for f in svg/faktway-znak*.svg; do
  n=$(basename "$f" .svg)
  for s in 512 1024 2048; do rsvg-convert -w "$s" -h "$s" -a "$f" -o "png/$n-$s.png"; done
done
# PDF wektorowe (RGB) dla drukarni: logo podstawowe, pionowe, znak, w kolorze, czerni i bieli
for n in faktway-logo faktway-logo-czarne faktway-logo-biale faktway-logo-pionowe faktway-logo-pionowe-czarne \
         faktway-znak faktway-znak-czarny faktway-znak-bialy; do
  rsvg-convert -f pdf "svg/$n.svg" -o "pdf/$n.pdf"
done
# Na biurowe dokumenty: JPG nie wychodzi z rsvg-convert, więc PNG na białym tle
rsvg-convert -w 1200 -b white svg/faktway-logo.svg -o png/faktway-logo-na-bialym-1200.png
echo "PNG: $(ls png | wc -l | tr -d ' ')  PDF: $(ls pdf | wc -l | tr -d ' ')"
