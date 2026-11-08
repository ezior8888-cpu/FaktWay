"""Pliki logo dla aplikacji: ścieżki do komponentu React, favicon, ikony PWA, plakietka powiadomień, logo do maili.

Uruchomienie (z katalogu zrodla/, po kit.py):  python3 aplikacja.py
Wymaga rsvg-convert (brew install librsvg). Ścieżki liczone od katalogu głównego repozytorium.

Co powstaje:
- lib/brand/faktway-logo-paths.ts          ścieżki SVG znaku i układu poziomego (wersja jasna i odchudzona ciemna)
- public/favicon.ico, public/icon.svg       favicon z rysunku na siatce pikseli (16/32/48 px)
- public/icons/icon-*.png                  ikony PWA „any”: biały znak na niebieskim kaflu z zaokrągleniem
- public/icons/maskable-*.png              ikony PWA „maskable”: pełne tło, znak w strefie bezpiecznej
- public/icons/apple-touch-icon.png        iOS (180 px, pełne tło; iOS sam zaokrągla)
- public/icons/badge-72x72.png             plakietka powiadomień Androida: biała sylwetka na przezroczystym
- public/brand/faktway-logo-email.png      logo do nagłówka maili (2x dla ekranów retina)
"""
import os
import shutil
import subprocess

import symbol as sym
import wordmark as wm
from geo import fmt
from kit import BLUE, WHITE, transform, wordmark_geometry

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../../.."))
ZESTAW = os.path.join(HERE, "../zestaw")
WEB = os.path.join(ZESTAW, "web")
PUBLIC = os.path.join(REPO, "public")

U = 20.0                              # u układu poziomego (jak w kit.horizontal_doc)


def lockup_frame():
    """Ramka układu poziomego: wspólna dla wersji jasnej i odchudzonej, żeby różniła je tylko grubość."""
    s = U / sym.U
    ws = 5 * U / (wm.B - wm.CAP)
    sw, sh = (v * s for v in sym.bbox())
    cy = sh / 2
    wx, wy = sw + 3 * U, cy - (wm.CAP + wm.B) / 2 * ws
    _, (_, x1, _, _) = wordmark_geometry()
    width = int(-(-(wx + x1 * ws) // 1))
    return dict(s=s, ws=ws, cx=sw / 2, cy=cy, wx=wx, wy=wy, width=width, height=int(sh))


def ts_module():
    f = lockup_frame()
    s = f["s"]
    lock_symbol = sym.halves(f["cx"], f["cy"], sym.R * s, sym.U * s, sym.U * s)
    lock_symbol_rev = sym.halves(f["cx"], f["cy"], sym.REVERSED["r"] * s, sym.REVERSED["gap"] * s, sym.REVERSED["shift"] * s)
    wm_brand, _ = wordmark_geometry(False)
    wm_rev, _ = wordmark_geometry(True)
    mw, mh = sym.bbox()
    mark = sym.halves(mw / 2, mh / 2)
    mark_rev = sym.halves(mw / 2, mh / 2, **sym.REVERSED)
    return f"""// Plik generowany: docs/brand/logo/zrodla/aplikacja.py (z tej samej geometrii co zestaw logo).
// Nie edytuj ręcznie. Wersja `reversed` to odchudzony rysunek na ciemne tło (szersza przerwa, cieńsze litery).

/** Układ poziomy: znak + napis FaktWay. */
export const LOCKUP = {{
  viewBox: '0 0 {f['width']} {f['height']}',
  symbol: {{
    brand: '{lock_symbol}',
    reversed: '{lock_symbol_rev}',
  }},
  wordmark: {{
    transform: '{transform(f['wx'], f['wy'], f['ws'])}',
    brand: '{wm_brand}',
    reversed: '{wm_rev}',
  }},
}} as const;

/** Sam znak „Przesunięcie”. */
export const MARK = {{
  viewBox: '0 0 {fmt(mw)} {fmt(mh)}',
  brand: '{mark}',
  reversed: '{mark_rev}',
}} as const;
"""


def tile_svg(full_bleed, symbol_width):
    """Biały znak (wersja odchudzona) na niebieskim kaflu 256×256, wyśrodkowany."""
    w, h = sym.bbox(**sym.REVERSED)
    k = symbol_width * 256 / w
    bg = '<rect width="256" height="256" fill="{}"/>' if full_bleed else '<rect width="256" height="256" rx="57.6" fill="{}"/>'
    d = sym.halves(128, 128, sym.REVERSED["r"] * k, sym.REVERSED["gap"] * k, sym.REVERSED["shift"] * k)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">'
            f'<title>FaktWay</title>{bg.format(BLUE)}<path fill="{WHITE}" d="{d}"/></svg>\n')


def badge_svg():
    """Plakietka: biała sylwetka znaku na małe rozmiary, 80% płótna, przezroczyste tło."""
    k = 0.8
    g = sym.SMALL
    d = sym.halves(128, 128, g["r"] * k, g["gap"] * k, g["shift"] * k)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">'
            f'<title>FaktWay</title><path fill="{WHITE}" d="{d}"/></svg>\n')


def render(src, out, w, h=None):
    args = ["rsvg-convert", "-w", str(w)] + (["-h", str(h)] if h else []) + [src, "-o", out]
    subprocess.run(args, check=True)


def main():
    with open(os.path.join(REPO, "lib/brand/faktway-logo-paths.ts"), "w") as fh:
        fh.write(ts_module())

    sources = {
        "faktway-ikona.svg": tile_svg(False, 0.62),
        "faktway-ikona-maskowalna.svg": tile_svg(True, 0.5),
        "faktway-plakietka.svg": badge_svg(),
    }
    for name, content in sources.items():
        with open(os.path.join(WEB, name), "w") as fh:
            fh.write(content)

    icons = os.path.join(PUBLIC, "icons")
    os.makedirs(icons, exist_ok=True)
    for size in (72, 96, 128, 144, 152, 192, 384, 512):
        render(os.path.join(WEB, "faktway-ikona.svg"), os.path.join(icons, f"icon-{size}x{size}.png"), size, size)
    for size in (192, 512):
        render(os.path.join(WEB, "faktway-ikona-maskowalna.svg"), os.path.join(icons, f"maskable-{size}x{size}.png"), size, size)
    render(os.path.join(WEB, "faktway-ikona-maskowalna.svg"), os.path.join(icons, "apple-touch-icon.png"), 180, 180)
    render(os.path.join(WEB, "faktway-plakietka.svg"), os.path.join(icons, "badge-72x72.png"), 72, 72)

    shutil.copy(os.path.join(WEB, "favicon.ico"), os.path.join(PUBLIC, "favicon.ico"))
    shutil.copy(os.path.join(WEB, "favicon.svg"), os.path.join(PUBLIC, "icon.svg"))

    os.makedirs(os.path.join(PUBLIC, "brand"), exist_ok=True)
    render(os.path.join(ZESTAW, "svg/faktway-logo.svg"), os.path.join(PUBLIC, "brand/faktway-logo-email.png"), 280)
    print("gotowe")


if __name__ == "__main__":
    main()
