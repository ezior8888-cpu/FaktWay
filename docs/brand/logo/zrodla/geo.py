"""Geometria pomocnicza: wielokąty z ujednoliconym kierunkiem, ukośne kreski o stałej grubości, pierścienie."""
import math

def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s

def area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2

def poly(pts, cw=True):
    """Zamknięty wielokąt; cw=True = zgodnie z ruchem wskazówek na ekranie (dodatnie pole przy osi y w dół)."""
    if (area(pts) > 0) != cw:
        pts = pts[::-1]
    return "M" + " L".join(f"{fmt(x)} {fmt(y)}" for x, y in pts) + " Z"

def rect(x0, y0, x1, y1):
    return poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])

def intersect(p, d, q, e):
    """Przecięcie prostych p + t*d oraz q + s*e."""
    den = d[0] * e[1] - d[1] * e[0]
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    return (p[0] + t * d[0], p[1] + t * d[1])

H = (1, 0)  # kierunek linii cięcia poziomego
V = (0, 1)  # kierunek linii cięcia pionowego

def stroke(a, b, w, cut_a, cut_b):
    """Kreska o grubości w (prostopadle) wzdłuż osi a->b, ucięta liniami cut_a i cut_b.
    cut_* = (punkt, kierunek) — np. ((0, 96), H) to poziome cięcie na y=96."""
    d = (b[0] - a[0], b[1] - a[1])
    n = math.hypot(*d)
    off = (-d[1] / n * w / 2, d[0] / n * w / 2)
    l = (a[0] + off[0], a[1] + off[1])
    r = (a[0] - off[0], a[1] - off[1])
    pts = [intersect(l, d, *cut_a), intersect(l, d, *cut_b), intersect(r, d, *cut_b), intersect(r, d, *cut_a)]
    return poly(pts)

def ellipse(cx, cy, rx, ry, cw=True):
    s = 1 if cw else 0
    return (f"M{fmt(cx - rx)} {fmt(cy)} A{fmt(rx)} {fmt(ry)} 0 1 {s} {fmt(cx + rx)} {fmt(cy)} "
            f"A{fmt(rx)} {fmt(ry)} 0 1 {s} {fmt(cx - rx)} {fmt(cy)} Z")

def ring(cx, cy, rxo, ryo, rxi, ryi):
    return ellipse(cx, cy, rxo, ryo, True) + " " + ellipse(cx, cy, rxi, ryi, False)

def svg(view_w, view_h, body, title="FaktWay", fill="#111111"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(view_w)} {fmt(view_h)}" '
            f'width="{fmt(view_w)}" height="{fmt(view_h)}" role="img" aria-labelledby="title">'
            f'<title id="title">{title}</title><g fill="{fill}">{body}</g></svg>\n')
