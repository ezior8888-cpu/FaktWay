# SPEC: mikrorachunek podatkowy z NIP

Źródła: Ordynacja podatkowa, art. 61b (wpłaty podatku na mikrorachunek
podatkowy); podatki.gov.pl, „Mikrorachunek podatkowy: jak sprawdzić numer
i wpłacić podatek” (budowa numeru) i oficjalny generator mikrorachunku MF
(wektor w punkcie 5); numer rachunku bankowego NRB (zarządzenie Prezesa NBP
w sprawie numeracji rachunków bankowych): liczba kontrolna jak w IBAN
(ISO 13616, ISO 7064 MOD 97-10); budowa NIP (10 cyfr, ostatnia kontrolna).
Rozporządzenie o rodzajach podatków wpłacanych na mikrorachunek (Dz.U. 2025
poz. 1305, zmiana Dz.U. 2026 poz. 1351 od 1.11.2026) mówi, CO się wpłaca
(symbole formularzy), a nie zmienia budowy numeru.

## 1. NIP

Wejście to napis. Wyrocznia przyjmuje tylko postać kanoniczną: dokładnie
10 cyfr 0-9, bez spacji, myślników i prefiksu kraju. Każdy inny napis to
brak.

Cyfra kontrolna: dla cyfr c1 … c10 reszta
r = (6·c1 + 5·c2 + 7·c3 + 2·c4 + 3·c5 + 4·c6 + 5·c7 + 6·c8 + 7·c9) mod 11.
Reszta 10: NIP niepoprawny. NIP jest poprawny, gdy r ≠ 10 i r = c10.

Przykład: 1234563218 (6+10+21+8+15+24+15+12+7 = 118, 118 mod 11 = 8 = c10)
jest poprawny; 1234563219 nie jest.

## 2. Mikrorachunek z NIP

Numer ma 26 cyfr w kolejności:
- LK: dwie cyfry kontrolne (punkt 4),
- 10100071: numer rozliczeniowy NBP,
- 222: numer uzupełniający NBP,
- 2: typ identyfikatora (2 = NIP; 1 = PESEL jest poza zakresem),
- NIP: 10 cyfr,
- 00: dwa zera dopełniające do 26 cyfr.

Niepoprawny NIP (punkt 1) daje brak, nigdy numer rachunku.

## 3. Czy numer jest mikrorachunkiem z NIP

Napis jest mikrorachunkiem z NIP, gdy jednocześnie:
- ma dokładnie 26 cyfr 0-9 (bez spacji),
- cyfry 3-13 to 10100071222,
- cyfra 14 to 2,
- cyfry 15-24 to poprawny NIP (punkt 1),
- cyfry 25-26 to 00,
- jest poprawnym NRB (punkt 4).

## 4. Liczba kontrolna i poprawny NRB

Liczba kontrolna jak w IBAN dla kraju PL: z 24 cyfr numeru bez LK (cyfry
3-26) tworzy się napis „24 cyfry” + „2521” + „00” (P = 25, L = 21),
traktuje go jako liczbę całkowitą, liczy resztę r z dzielenia przez 97,
a LK = 98 - r, zapisane dwiema cyframi (z zerem na początku, np. 05).

Napis jest poprawnym NRB, gdy ma dokładnie 26 cyfr 0-9, a liczba z napisu
„cyfry 3-26” + „2521” + „cyfry 1-2” daje resztę 1 z dzielenia przez 97.

Liczby mają do 30 cyfr: liczyć na liczbach całkowitych dowolnej wielkości
albo resztę kawałkami, nigdy na liczbach zmiennoprzecinkowych.

## 5. Zapis do pokazania

Dwie cyfry kontrolne, spacja, potem 24 cyfry w sześciu grupach po cztery,
oddzielonych pojedynczą spacją: „LK BBBB BBBB BBBB BBBB BBBB BBBB”.

Wektor z oficjalnego generatora MF (odczyt 5.11.2026): NIP 1234563218 daje
88101000712222123456321800, zapis „88 1010 0071 2222 1234 5632 1800”.

## 6. Funkcje wyroczni

- `nipPoprawny(nip: string): boolean` (punkt 1),
- `mikrorachunekZNip(nip: string): string | null` (punkt 2; 26 cyfr bez spacji albo `null`),
- `czyMikrorachunekZNip(numer: string): boolean` (punkt 3),
- `nrbPoprawny(numer: string): boolean` (punkt 4),
- `zapisRachunku(numer: string): string` (punkt 5; wejście to 26 cyfr).

Bez importów spoza katalogu wyroczni. Każde miejsce, w którym ta specyfikacja
nie rozstrzyga, opisz komentarzem zaczynającym się od „Wątpliwość:”.
