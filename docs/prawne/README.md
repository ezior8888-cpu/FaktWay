# Dokumentacja prawna FaktWay — wewnętrzna

Dokumenty, których wymagają RODO i nasze własne dokumenty dla klientów
(regulamin, umowa powierzenia, polityki — treść w `lib/legal/documents/`,
strony `/legal/*`). Przygotowane 15.10.2026 do przeglądu przez prawnika;
dopóki prawnik ich nie zatwierdzi, traktuj je jako projekt.

| Plik | Po co | Podstawa |
|---|---|---|
| [lista-kontrolna-przed-startem.md](lista-kontrolna-przed-startem.md) | Co musi być zrobione, zanim dokumenty zaczną obowiązywać | — |
| [rejestr-czynnosci-przetwarzania.md](rejestr-czynnosci-przetwarzania.md) | Rejestr jako administrator i jako podmiot przetwarzający | art. 30 ust. 1 i 2 RODO |
| [procedura-naruszen.md](procedura-naruszen.md) | Co robić przy wycieku lub utracie danych — terminy 36 h / 72 h | art. 33, 34 RODO; umowa powierzenia § 8 |
| [procedura-zadan-i-reklamacji.md](procedura-zadan-i-reklamacji.md) | Żądania RODO, reklamacje, odstąpienia, zgłoszenia treści bezprawnych | art. 12–22 RODO; regulamin § 8, 12, 13; DSA art. 16–17 |
| [procedura-zmiany-podprocesora.md](procedura-zmiany-podprocesora.md) | Nowy dostawca, który widzi dane osobowe | art. 28 ust. 2 RODO; umowa powierzenia § 6 |

**Gdzie co jest w kodzie:**

- dane usługodawcy — `lib/legal/entity.ts` (jedno miejsce);
- lista dostawców — `lib/legal/subprocessors.ts` (polityka, umowa powierzenia
  i `/legal/podprocesorzy` czytają ją automatycznie);
- wersje dokumentów i brzmienie oświadczeń — `lib/legal/versions.ts`;
- zapis akceptacji i zgód — `lib/legal/record.ts`, `app_metadata.legal`
  konta + wpisy `legal.*` w `audit_logs`.

Te pliki są w publicznym repozytorium. Nie wpisuj tu danych osobowych,
adresów serwerów, haseł ani treści konkretnych zgłoszeń — rejestr naruszeń
i rejestr żądań prowadź poza repozytorium (patrz procedury).
