"""Generuje wzorcowe pliki SVG logo FaktWay do docs/brand/logo/zestaw/svg/.

Uruchomienie (z katalogu zrodla/):  python3 kit.py ../zestaw/svg

Układy opierają się na jednostce u = szerokość przerwy w znaku w danym układzie:
- poziomy:  wysokość wersalików napisu 5u, odstęp znak-napis 3u, środek znaku na środku wersalików;
- pionowy:  wysokość wersalików 3u, odstęp znak-napis 2u, oba elementy wyśrodkowane w poziomie.
Pole ochronne wokół każdej wersji: 2u.
"""
import math
import re
import sys

import symbol as sym
import wordmark as wm
from geo import fmt

BLUE = "#2463EF"    # niebieski FaktWay (= --primary aplikacji)
NAVY = "#0D1936"    # granat: napis, ciemne tła
LIGHT = "#61A4F7"   # jasny niebieski: znak na ciemnym tle (= --primary trybu ciemnego)
WHITE = "#FFFFFF"
BLACK = "#000000"

TITLE = "FaktWay"


def doc(w, h, body):
    w, h = math.ceil(w - 0.01), math.ceil(h - 0.01)   # całkowite płótno; zapas < 1 jednostki z prawej/dołu
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" width="{fmt(w)}" '
            f'height="{fmt(h)}" role="img" aria-labelledby="title"><title id="title">{TITLE}</title>{body}</svg>\n')


def symbol_path(cx, cy, scale=1.0, geo=None, fill=BLUE):
    g = dict(r=sym.R, gap=sym.U, shift=sym.U)
    g.update(geo or {})
    d = sym.halves(cx, cy, g["r"] * scale, g["gap"] * scale, g["shift"] * scale)
    return f'<path id="znak" fill="{fill}" d="{d}"/>'


def wordmark_geometry(reversed_=False):
    """Ścieżki napisu w jego układzie oraz ramka (x0, x1, y0, y1)."""
    wm.weight(-0.6 if reversed_ else 0.0)
    parts, _ = wm.layout()
    wm.weight(0.0)
    d = " ".join(parts)
    xs = [float(m) for m in re.findall(r"[ML](-?[\d.]+) -?[\d.]+", d)]
    return d, (0.0, max(xs), wm.ASC, wm.DESC)


def transform(x, y, scale):
    """Przesunięcie i skala napisu z 4 miejscami po przecinku (2 miejsca zmieniały skalę o 0,6%)."""
    num = lambda v: f"{v:.4f}".rstrip("0").rstrip(".")
    return f"translate({num(x)} {num(y)}) scale({num(scale)})"


def wordmark_path(x, y, scale, fill, reversed_=False):
    """Napis przesunięty tak, że punkt (0, 0) jego układu trafia w (x, y)."""
    d, _ = wordmark_geometry(reversed_)
    return f'<path id="napis" fill="{fill}" transform="{transform(x, y, scale)}" d="{d}"/>'


# ---------- znak ----------

def symbol_doc(fill, geo=None):
    g = dict(r=sym.R, gap=sym.U, shift=sym.U)
    g.update(geo or {})
    w, h = sym.bbox(**g)
    return doc(w, h, symbol_path(w / 2, h / 2, 1.0, g, fill))


def symbol_small_doc(fill):
    """Wersja na małe rozmiary na płótnie 256 (siatka pikseli 16 px)."""
    return doc(256, 256, symbol_path(128, 128, 1.0, sym.SMALL, fill))


# ---------- napis ----------

def wordmark_doc(fill, reversed_=False):
    _, (x0, x1, y0, y1) = wordmark_geometry(reversed_)
    return doc(x1 - x0, y1 - y0, wordmark_path(-x0, -y0, 1.0, fill, reversed_))


# ---------- układ poziomy ----------

def horizontal_doc(sym_fill, wm_fill, reversed_=False, u=20.0):
    s = u / sym.U                        # skala znaku
    cap = 5 * u
    ws = cap / (wm.B - wm.CAP)           # skala napisu
    geo = sym.REVERSED if reversed_ else {}
    g = dict(r=sym.R, gap=sym.U, shift=sym.U); g.update(geo)
    sw, sh = sym.bbox(**g)
    sw, sh = sw * s, sh * s
    _, (x0, x1, y0, y1) = wordmark_geometry(reversed_)
    cy = sh / 2                          # środek znaku = środek wersalików
    wx = sw + 3 * u
    wy = cy - (wm.CAP + wm.B) / 2 * ws   # pozycja (0,0) układu napisu
    top = min(0, wy + y0 * ws)
    bottom = max(sh, wy + y1 * ws)
    width = wx + x1 * ws
    body = (symbol_path(sw / 2, cy - top, s, geo, sym_fill) +
            wordmark_path(wx, wy - top, ws, wm_fill, reversed_))
    return doc(width, bottom - top, body)


# ---------- układ pionowy ----------

def stacked_doc(sym_fill, wm_fill, reversed_=False, u=26.0):
    s = u / sym.U
    cap = 3 * u
    ws = cap / (wm.B - wm.CAP)
    geo = sym.REVERSED if reversed_ else {}
    g = dict(r=sym.R, gap=sym.U, shift=sym.U); g.update(geo)
    sw, sh = sym.bbox(**g)
    sw, sh = sw * s, sh * s
    _, (x0, x1, y0, y1) = wordmark_geometry(reversed_)
    ww = x1 * ws
    width = max(sw, ww)
    wy = sh + 2 * u - wm.CAP * ws        # góra wersalików 2u pod znakiem
    bottom = wy + y1 * ws
    body = (symbol_path(width / 2, sh / 2, s, geo, sym_fill) +
            wordmark_path((width - ww) / 2, wy, ws, wm_fill, reversed_))
    return doc(width, bottom, body)


def main(out):
    files = {
        # znak
        "faktway-znak.svg": symbol_doc(BLUE),
        "faktway-znak-granat.svg": symbol_doc(NAVY),
        "faktway-znak-czarny.svg": symbol_doc(BLACK),
        "faktway-znak-bialy.svg": symbol_doc(WHITE, sym.REVERSED),
        "faktway-znak-negatyw.svg": symbol_doc(LIGHT, sym.REVERSED),
        "faktway-znak-maly.svg": symbol_small_doc(BLUE),
        "faktway-znak-maly-bialy.svg": symbol_small_doc(WHITE),
        # napis
        "faktway-napis.svg": wordmark_doc(NAVY),
        "faktway-napis-niebieski.svg": wordmark_doc(BLUE),
        "faktway-napis-czarny.svg": wordmark_doc(BLACK),
        "faktway-napis-bialy.svg": wordmark_doc(WHITE, True),
        # układ poziomy (podstawowy)
        "faktway-logo.svg": horizontal_doc(BLUE, NAVY),
        "faktway-logo-niebieskie.svg": horizontal_doc(BLUE, BLUE),
        "faktway-logo-granat.svg": horizontal_doc(NAVY, NAVY),
        "faktway-logo-czarne.svg": horizontal_doc(BLACK, BLACK),
        "faktway-logo-biale.svg": horizontal_doc(WHITE, WHITE, True),
        "faktway-logo-negatyw.svg": horizontal_doc(LIGHT, WHITE, True),
        # układ pionowy
        "faktway-logo-pionowe.svg": stacked_doc(BLUE, NAVY),
        "faktway-logo-pionowe-niebieskie.svg": stacked_doc(BLUE, BLUE),
        "faktway-logo-pionowe-granat.svg": stacked_doc(NAVY, NAVY),
        "faktway-logo-pionowe-czarne.svg": stacked_doc(BLACK, BLACK),
        "faktway-logo-pionowe-biale.svg": stacked_doc(WHITE, WHITE, True),
        "faktway-logo-pionowe-negatyw.svg": stacked_doc(LIGHT, WHITE, True),
    }
    for name, content in files.items():
        with open(f"{out}/{name}", "w") as fh:
            fh.write(content)
        print(name)


if __name__ == "__main__":
    main(sys.argv[1])
