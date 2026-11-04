"""Znak FaktWay „Przesunięcie”: koło przecięte poziomo, połówki przesunięte w przeciwne strony.

Reguła konstrukcji: jednostka u = szerokość przerwy. Promień R = 4u, przerwa = 1u, każda połówka
przesunięta o 1u (górna w prawo, dolna w lewo), więc połówki są względem siebie przesunięte o 2u.
Znak jest środkowo symetryczny (obrót o 180° daje ten sam kształt).
"""
from geo import fmt

U = 22                       # jednostka w pliku wzorcowym
R = 4 * U

def halves(cx, cy, r=R, gap=U, shift=U):
    top = f"M{fmt(cx - r + shift)} {fmt(cy - gap / 2)} A{fmt(r)} {fmt(r)} 0 0 1 {fmt(cx + r + shift)} {fmt(cy - gap / 2)} Z"
    bot = f"M{fmt(cx + r - shift)} {fmt(cy + gap / 2)} A{fmt(r)} {fmt(r)} 0 0 1 {fmt(cx - r - shift)} {fmt(cy + gap / 2)} Z"
    return f"{top} {bot}"

# Wersja na ciemne tło: jasny kształt wygląda na większy (irradiacja), więc przerwa jest szersza o ok. 10%,
# a promień mniejszy o 1, żeby obrys całości optycznie zgadzał się z wersją na jasnym tle.
REVERSED = dict(r=R - 1, gap=U + 2, shift=U)

# Wersja na małe rozmiary (16–24 px): na płótnie 256 krawędzie płaskie leżą na siatce 16 (piksel przy 16 px),
# przerwa to 2 piksele, przesunięcie większe względem promienia, żeby ruch było widać.
SMALL = dict(r=96, gap=32, shift=24)

def bbox(r=R, gap=U, shift=U):
    """Szerokość i wysokość znaku."""
    return 2 * r + 2 * shift, 2 * r + gap
