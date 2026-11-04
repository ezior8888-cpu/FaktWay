"""Napis FaktWay zbudowany z figur (bez fontu). Układ: linia bazowa y=200, wersaliki 140, x-height 104.

Zasady: trzon 22, kreski poziome 20 (wyglądają na grubsze), ukośne 21; wszystkie zakończenia cięte poziomo,
jak przecięcie w znaku; ukośne W dokładnie 15° od pionu; okrągłe litery wychodzą 2 poza linie (przestrzał)."""
from geo import rect, ring, stroke, poly, H, V, fmt

B, CAP, X, ASC, DESC = 200, 60, 96, 52, 246   # linia bazowa i wysokości (y w dół)
S, HS, D, O = 22, 20, 21, 2                     # trzon, poziome (cieńsze), ukośne, przestrzał

def weight(delta=0.0):
    """Zmienia grubość wszystkich kresek o delta. Wersja na ciemne tło używa ujemnej (irradiacja)."""
    global S, HS, D
    S, HS, D = 22 + delta, 20 + delta, 21 + delta

def F(x):
    w = 80
    return [rect(x, CAP, x + S, B), rect(x + S, CAP, x + w, CAP + HS), rect(x + S, 117, x + w - 8, 117 + HS)], w

def a(x):
    r = X and (B - X) / 2 + O            # 54: promień zewnętrzny z przestrzałem
    cx, cy = x + r, B - (B - X) / 2      # środek miski
    parts = [ring(cx, cy, r, r, r - S - 1, r - HS - 1), rect(cx + r - S, X, cx + r, B)]
    return parts, 2 * r

def k(x):
    j = (x + S, 150); t = (x + 64, X)
    arm = stroke(j, t, D, ((x + S / 2, 0), V), ((0, X), H))
    l0 = (j[0] + 0.38 * (t[0] - j[0]), j[1] + 0.38 * (t[1] - j[1]))
    leg = stroke(l0, (x + 72, B), D, ((l0[0] - 4, l0[1] + 4), (1, -1)), ((0, B), H))
    return [rect(x, ASC, x + S, B), arm, leg], 84

def t(x, bar_right=22):
    s0 = x + 18
    return [rect(s0, 70, s0 + S, B), rect(x, X, s0 + S + bar_right, X + HS)], 18 + S + bar_right

def W(x):
    """Wszystkie cztery kreski dokładnie 15° od pionu; wierzchołki zbiegają się 10 poza linią i są cięte płasko."""
    import math
    dep = 10
    tn = math.tan(math.radians(15))
    b1 = x + 52
    b2 = b1 + 2 * (B - CAP + 2 * dep) * tn
    tops = [b1 - (B - CAP + dep) * tn, b1 + (B - CAP + 2 * dep) * tn, b2 + (B - CAP + dep) * tn]
    bots = [b1, b2]
    top_y = [CAP, CAP - dep, CAP]
    parts = []
    for i in range(2):
        parts.append(stroke((tops[i], top_y[i]), (bots[i], B + dep), D, ((0, CAP), H), ((0, B), H)))
        parts.append(stroke((tops[i + 1], top_y[i + 1]), (bots[i], B + dep), D, ((0, CAP), H), ((0, B), H)))
    return parts, tops[2] + 12 - x

def y(x):
    v = (x + 51, B - 2)
    rd = (v[0] - (x + 92), v[1] - X)            # kierunek prawej kreski
    left = stroke((x + 10, X), v, D, ((0, X), H), (v, rd))   # lewa kończy się na osi prawej
    right = stroke((x + 92, X), v, D, ((0, X), H), ((0, DESC), H))
    return [left, right], 102

GLYPHS = {"F": F, "a": a, "k": k, "t": t, "W": W, "y": y}

# odstępy między parami (dobrane okiem, optycznie)
GAPS = {"Fa": 2, "ak": 15, "kt": 10, "tW": 6, "Wa": 0, "ay": 6}

def layout(word="FaktWay", gaps=None, overrides=None):
    gaps = gaps or GAPS
    overrides = overrides or {}
    x, parts = 0.0, []
    for i, ch in enumerate(word):
        fn = overrides.get(i, GLYPHS[ch])
        p, w = fn(x)
        parts += p
        if i + 1 < len(word):
            x += w + gaps.get(ch + word[i + 1], 10)
        else:
            x += w
    return parts, x
