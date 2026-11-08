"""Tłumaczy stałe napisy planszy (presentation_board.py generuje je po angielsku). Użycie: python3 plansza-pl.py plansza.html"""
import sys

PL = {
    "What we heard": "Brief", "The brief": "Co ma robić znak",
    "Final identity": "Logo FaktWay", "Final design": "Projekt końcowy",
    "Logo · in use": "Logo w użyciu", "Next steps": "Dalej", ">Notes<": ">Co dalej<",
    "App icon": "Ikona aplikacji", "Browser tab": "Zakładka przeglądarki", "Business cards": "Wizytówki",
    "Laptop sticker": "Naklejka", "Social profile": "Profil w mediach społecznościowych", ">Website<": ">Strona<",
    "Alex Morgan": "Imię Nazwisko", "Founder": "Założyciel", "alex@faktway.com": "kontakt@faktway.pl",
    "https://faktway.com": "https://faktway.pl", "FaktWay — Home": "FaktWay: faktury przez KSeF",
    "FaktWay — logo": "FaktWay: logo", "lang='en'": "lang='pl'",
}

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
for en, pl in PL.items():
    s = s.replace(en, pl)
open(path, "w", encoding="utf-8").write(s)
