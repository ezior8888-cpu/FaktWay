"""Ilustracje do instrukcji logo (docs/brand/logo/README.md) w docs/brand/logo/zestaw/instrukcja/.

Uruchomienie (z katalogu zrodla/, po kit.py):  python3 instrukcja.py ../zestaw
Ilustracje to pomoce, nie pliki logo: zawierają podpisy fontem systemowym.
"""
import re
import sys

import symbol as sym
from kit import BLUE, NAVY, LIGHT

OUT = sys.argv[1]
FONT = "font-family=\"Outfit, 'Helvetica Neue', Arial, sans-serif\""
GREY = "#8A93A6"
RED = "#E5484D"


def master(name):
    """Zawartość i wymiary pliku wzorcowego."""
    s = open(f"{OUT}/svg/{name}.svg").read()
    w, h = (float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', s).groups())
    inner = re.sub(r"<title[^>]*>.*?</title>", "", s.split(">", 1)[1].rsplit("</svg>", 1)[0])
    return inner, w, h


def place(name, x, y, width=None, height=None, extra=""):
    """Wstawia plik wzorcowy jako zagnieżdżony <svg> o zadanej szerokości albo wysokości."""
    inner, w, h = master(name)
    if width is None:
        width = height * w / h
    height = width * h / w
    return (f'<svg x="{x:.1f}" y="{y:.1f}" width="{width:.1f}" height="{height:.1f}" '
            f'viewBox="0 0 {w:g} {h:g}" {extra}>{inner}</svg>'), width, height


def page(w, h, body, bg="#FFFFFF"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'<rect width="{w}" height="{h}" fill="{bg}"/>{body}</svg>\n')


def label(x, y, text, size=13, fill=GREY, anchor="start", weight=400):
    return (f'<text x="{x}" y="{y}" {FONT} font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}">{text}</text>')


def write(name, content):
    with open(f"{OUT}/instrukcja/{name}", "w") as fh:
        fh.write(content)
    print(name)


# 1. Konstrukcja znaku ---------------------------------------------------------
def konstrukcja():
    k = 1.6
    R, u = sym.R * k, sym.U * k
    cx, cy = 300, 200
    b = [f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{GREY}" stroke-width="1.5" stroke-dasharray="6 6"/>',
         f'<path fill="{BLUE}" fill-opacity="0.92" d="{sym.halves(cx, cy, R, u, u)}"/>']
    # przerwa = u (wymiar po prawej)
    x = cx + R + u + 18
    b += [f'<path d="M{x - 6} {cy - u / 2} H{x + 6} M{x - 6} {cy + u / 2} H{x + 6} M{x} {cy - u / 2} V{cy + u / 2}" stroke="{NAVY}" stroke-width="1.5"/>',
          label(x + 12, cy + 5, "u (przerwa)", 14, NAVY)]
    # pod znakiem: przesunięcie dolnej połówki (u) i jej promień (R = 4u)
    y = cy + u / 2 + R + 22
    xl, xc = cx - R - u, cx - u            # lewa krawędź i środek dolnej połówki
    b += [f'<path d="M{xl} {y - 6} V{y + 6} M{cx - R} {y - 6} V{y + 6} M{xl} {y} H{cx - R}" stroke="{NAVY}" stroke-width="1.5"/>',
          label(cx - R - u / 2, y + 22, "u", 14, NAVY, "middle"),
          f'<path d="M{xc} {y - 6} V{y + 6} M{xc + R} {y - 6} V{y + 6} M{xc} {y} H{xc + R}" stroke="{NAVY}" stroke-width="1.5"/>',
          label(xc + R / 2, y + 22, "R = 4u", 14, NAVY, "middle", 600),
          f'<path d="M{xc} {cy + u / 2} V{y}" stroke="{GREY}" stroke-width="1" stroke-dasharray="3 3"/>']
    # nad znakiem: przesunięcie górnej połówki (u)
    y2 = cy - u / 2 - R - 14
    b += [f'<path d="M{cx + R} {y2 - 6} V{y2 + 6} M{cx + R + u} {y2 - 6} V{y2 + 6} M{cx + R} {y2} H{cx + R + u}" stroke="{NAVY}" stroke-width="1.5"/>',
          label(cx + R + u / 2, y2 - 10, "u", 14, NAVY, "middle")]
    b.append(label(24, 440, "Koło o promieniu R przecięte poziomo. Przerwa i przesunięcie każdej połówki to u = R/4.", 13))
    return page(600, 460, "".join(b))


# 2. Pole ochronne -------------------------------------------------------------
def pole_ochronne():
    inner, w, h = master("faktway-logo")
    scale = 0.62
    u = 20 * scale                          # u układu poziomego = 20 jednostek pliku
    m = 2 * u
    x0, y0 = 60, 50
    W, H = w * scale, h * scale
    b = [f'<rect x="{x0 - m}" y="{y0 - m}" width="{W + 2 * m}" height="{H + 2 * m}" fill="#E8F0FE"/>',
         f'<rect x="{x0}" y="{y0}" width="{W}" height="{H}" fill="#FFFFFF"/>',
         place("faktway-logo", x0, y0, W)[0]]
    for (x, y) in [(x0 - m, y0 - m), (x0 + W, y0 - m), (x0 - m, y0 + H), (x0 + W, y0 + H)]:
        b.append(f'<rect x="{x}" y="{y}" width="{m}" height="{m}" fill="none" stroke="{BLUE}" stroke-width="1" stroke-dasharray="3 3"/>')
    b += [label(x0 - m, y0 + H + m + 26, "Pole ochronne: 2u z każdej strony, gdzie u to szerokość przerwy w znaku.", 13),
          label(x0 - m, y0 + H + m + 46, "W tym polu nie stawiamy tekstu, krawędzi zdjęć ani innych logo.", 13)]
    return page(int(W + 2 * x0), int(H + 2 * m + 130), "".join(b))


# 3. Dozwolone tła -------------------------------------------------------------
def tla():
    tiles = [("#FFFFFF", "faktway-logo", "podstawowe na bieli"),
             (BLUE, "faktway-logo-biale", "białe na niebieskim"),
             (NAVY, "faktway-logo-negatyw", "negatyw na granacie"),
             ("#161616", "faktway-logo-negatyw", "negatyw na ciemnym (tryb ciemny)"),
             ("#F3F5F9", "faktway-logo-granat", "granatowe na jasnoszarym"),
             ("#FFFFFF", "faktway-logo-czarne", "czarne (druk jednokolorowy, faks)")]
    tw, th, gap = 300, 120, 16
    b = []
    for i, (bg, name, text) in enumerate(tiles):
        x, y = 16 + (i % 2) * (tw + gap), 16 + (i // 2) * (th + 40)
        b.append(f'<rect x="{x}" y="{y}" width="{tw}" height="{th}" rx="10" fill="{bg}" stroke="#E2E6EE"/>')
        b.append(place(name, x + 40, y + (th - 44) / 2, tw - 80)[0])
        b.append(label(x, y + th + 22, text, 13))
    return page(2 * tw + gap + 32, 3 * (th + 40) + 8, "".join(b))


# 4. Czego nie robić -----------------------------------------------------------
def bledy():
    tw, th, gap = 200, 120, 16
    cells = []
    # rozciągnięte
    inner, w, h = master("faktway-znak")
    cells.append(("nie rozciągaj",
                  f'<svg x="40" y="34" width="120" height="54" viewBox="0 0 {w:g} {h:g}" preserveAspectRatio="none">{inner}</svg>'))
    # obrócone
    cells.append(("nie obracaj",
                  f'<g transform="rotate(-18 100 60)">{place("faktway-znak", 62, 26, 76)[0]}</g>'))
    # inne kolory
    d = sym.halves(100, 60, 30, 7.5, 7.5)
    cells.append(("nie zmieniaj kolorów",
                  f'<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#22C55E"/><stop offset="1" stop-color="#F59E0B"/></linearGradient></defs>'
                  f'<path fill="url(#g)" d="{d}"/>'))
    # odbite (ruch wstecz)
    cells.append(("nie odbijaj (ruch w drugą stronę)",
                  f'<g transform="translate(200 0) scale(-1 1)">{place("faktway-znak", 62, 26, 76)[0]}</g>'))
    # inny układ
    cells.append(("nie przestawiaj części",
                  place("faktway-napis", 22, 44, 110)[0] + place("faktway-znak", 142, 40, 40)[0]))
    # napis innym fontem
    cells.append(("nie przepisuj napisu fontem",
                  place("faktway-znak", 22, 42, 40)[0] +
                  f'<text x="72" y="73" font-family="Georgia, serif" font-size="30" fill="{NAVY}">FaktWay</text>'))
    b = []
    for i, (text, art) in enumerate(cells):
        x, y = 16 + (i % 3) * (tw + gap), 16 + (i // 3) * (th + 44)
        b.append(f'<rect x="{x}" y="{y}" width="{tw}" height="{th}" rx="10" fill="#FFFFFF" stroke="#E2E6EE"/>')
        b.append(f'<svg x="{x}" y="{y}" width="{tw}" height="{th}" viewBox="0 0 200 120">{art}</svg>')
        b.append(f'<path d="M{x + tw - 26} {y + 12} l14 14 M{x + tw - 12} {y + 12} l-14 14" stroke="{RED}" stroke-width="2.5" stroke-linecap="round"/>')
        b.append(label(x, y + th + 22, text, 13))
    return page(3 * tw + 2 * gap + 32, 2 * (th + 44) + 8, "".join(b), "#F7F8FA")


# 5. W użyciu: nagłówek faktury PDF i mail --------------------------------------
def uzycie():
    b = []
    # faktura (fragment A4)
    x, y, W, H = 24, 24, 380, 300
    b.append(f'<rect x="{x}" y="{y}" width="{W}" height="{H}" fill="#FFFFFF" stroke="#E2E6EE"/>')
    b.append(label(x + 28, y + 44, "Faktura VAT", 15, NAVY, "start", 600))
    b.append(label(x + 28, y + 62, "FV/2026/10/001", 11, GREY))
    b.append(f'<rect x="{x + W - 118}" y="{y + 28}" width="90" height="36" rx="6" fill="none" stroke="#D5DAE3" stroke-dasharray="4 3"/>')
    b.append(label(x + W - 73, y + 50, "logo sprzedawcy", 9, GREY, "middle"))
    for col in (0, 1):
        cx = x + 28 + col * 170
        b.append(label(cx, y + 100, "Sprzedawca" if col == 0 else "Nabywca", 10, GREY))
        for j, ln in enumerate((120, 96, 110)):
            b.append(f'<rect x="{cx}" y="{y + 110 + j * 14}" width="{ln}" height="6" rx="3" fill="#E4E8F0"/>')
    b.append(f'<rect x="{x + 28}" y="{y + 175}" width="{W - 56}" height="22" fill="#F3F5F9"/>')
    for j in range(3):
        b.append(f'<rect x="{x + 28}" y="{y + 207 + j * 18}" width="{W - 56}" height="1" fill="#E4E8F0"/>')
    b.append(f'<rect x="{x + 28}" y="{y + H - 38}" width="{W - 56}" height="1" fill="#EEEEEE"/>')
    b.append(place("faktway-znak", x + W / 2 - 74, y + H - 30, 11)[0])
    b.append(label(x + W / 2 + 6, y + H - 21, "Wygenerowano w FaktWay", 9, GREY, "middle"))
    b.append(label(x, y + H + 24, "PDF faktury: znak FaktWay tylko w stopce.", 13))
    # mail
    x2 = x + W + 32
    b.append(f'<rect x="{x2}" y="{y}" width="{W}" height="{H}" fill="#F3F5F9" stroke="#E2E6EE"/>')
    b.append(f'<rect x="{x2 + 30}" y="{y + 24}" width="{W - 60}" height="{H - 48}" rx="8" fill="#FFFFFF"/>')
    b.append(place("faktway-logo", x2 + 54, y + 46, 104)[0])
    b.append(label(x2 + 54, y + 108, "Faktura przyjęta przez KSeF", 15, NAVY, "start", 600))
    for j, ln in enumerate((250, 230, 180)):
        b.append(f'<rect x="{x2 + 54}" y="{y + 124 + j * 14}" width="{ln}" height="6" rx="3" fill="#E4E8F0"/>')
    b.append(f'<rect x="{x2 + 54}" y="{y + 182}" width="132" height="34" rx="8" fill="{BLUE}"/>')
    b.append(label(x2 + 120, y + 204, "Zobacz fakturę", 12, "#FFFFFF", "middle", 600))
    b.append(label(x2, y + H + 24, "Mail: logo poziome, 140 px szerokości.", 13))
    return page(2 * W + 80, H + 64, "".join(b), "#FFFFFF")


# 6. Kolory --------------------------------------------------------------------
def kolory():
    sw = [(BLUE, "Niebieski FaktWay", "#2463EF", "#FFFFFF"),
          (NAVY, "Granat", "#0D1936", "#FFFFFF"),
          (LIGHT, "Jasny niebieski", "#61A4F7", NAVY)]
    b = []
    for i, (c, name, hexv, fg) in enumerate(sw):
        x = 16 + i * 216
        b.append(f'<rect x="{x}" y="16" width="200" height="120" rx="10" fill="{c}"/>')
        b.append(label(x + 16, 104, name, 15, fg, "start", 600))
        b.append(label(x + 16, 124, hexv, 13, fg))
    return page(16 + 3 * 216, 152, "".join(b))


if __name__ == "__main__":
    import os
    os.makedirs(f"{OUT}/instrukcja", exist_ok=True)
    write("konstrukcja.svg", konstrukcja())
    write("pole-ochronne.svg", pole_ochronne())
    write("tla.svg", tla())
    write("bledy.svg", bledy())
    write("uzycie.svg", uzycie())
    write("kolory.svg", kolory())
