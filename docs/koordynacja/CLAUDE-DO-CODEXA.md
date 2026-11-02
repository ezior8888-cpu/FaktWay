# Claude ↔ Codex — sprawy do decyzji i uzgodnienia

Plik prowadzi **Claude** (strumień `claude/*`) dla **Codexa** (strumień `codex/*`),
na prośbę Igora z 28.09.2026. Dwa strumienie AI zmieniają te same pliki —
tu zapisujemy to, czego nie widać z samego kodu: decyzje do podjęcia,
konflikty, konwencje, rzeczy przekazane „przez płot”.

## Jak używać

- Każda sprawa ma numer **C-NN**, status i właściciela decyzji.
- **Status:** `OTWARTE` → `W TOKU` → `ROZSTRZYGNIĘTE (data, jak)`. Rozstrzygnięte
  przenosimy na dół, do archiwum — nie kasujemy.
- **Codex odpowiada pod sprawą** w sekcji „Odpowiedź Codexa” (albo w swoim
  dzienniku z odnośnikiem tutaj). Decyzje produktowe i podatkowe podejmuje
  **Igor** (z Bartoszem / księgową), nie żaden z nas.
- Dowód rozstrzyga: plik i linia, test, próbne scalenie — nie „wydaje mi się”.

## Wspólne zasady (z dziennika Bartosza, wydanie 25.09)

- Każdy PR **od `main`, bez stosów**; merge commit; `main` tylko przez PR z zielonymi kontrolami.
- Migracje = **prośby** do Bartosza; kolejność względem kodu opisana w PR.
- **Nie zmieniamy cudzych gałęzi.** Kto scala drugi, ten rozwiązuje konflikt.
- Nowy `*.ts` poza `tests/` nie importuje niczego z `.dockerignore`.

## Rejestr numerów migracji

Przed nadaniem numeru: sprawdzić `main` **i wszystkie gałęzie zdalne**.

| Numer | Kto | Plik | Stan (28.09) |
|---|---|---|---|
| 00083–00085 | Codex (#62) | `stripe_customer_claim`, `stripe_failed_payment_reference_rotation`, `stripe_checkout_session_id` | PR otwarty |
| 00086–00088 | Codex (#63) | `ksef_certificate_claim_guard`, `correction_parent_boundary`, `invoice_pending_content_freeze` | PR otwarty |
| 00089–00090 | Codex (#64) | `incoming_ksef_identity`, `expense_ksef_invoice_identity` | PR otwarty |
| 00091 | Claude | `tenant_vat_exemption` | w `main`, **wgrana 28.09** |
| 00092 | Claude | `tenant_tax_office_code` | w `main`, **wgrana 28.09** |
| 00093 | Codex (#71) | `invoice_delivery_history_guard` | PR otwarty |
| 00094 | Claude | `tenant_vat_cash_method` | w `main`, **wgrana 28.09** |
| 00095 | Codex (#71) | `expense_provenance_guard` | PR otwarty |
| 00096 | Codex (#83) → Claude przeniósł 1:1 na `main` (01.10) | `incoming_invoice_number_boundary` (C-08) | w `main` (#117), **wgrana na db-1 01.10** |
| 00097 | Codex (#86) | `invoices_overdue_reconciliation_guard` — **przeniesione jako 00126** (C-20) | zastąpione |
| 00098 | Bartosz (#90) | `backup_read_stripe_service_tables` | w `main` (#90, 02.10), **wgrana na db-1 28.09** |
| 00099 | Claude | `ksef_submission_references` (C-18) | PR `claude/ksef-niepewny-wynik`; wgranie PRZED wdrożeniem kodu |
| 00100 | Claude | `ops_gate` (bramka Telegram: rola `ops_actor`, schemat `ops`) | PR `claude/bramka-telegram`; wgranie PRZED uruchomieniem bramki |
| 00100–00101 | Codex (#128, szkic) | `ksef_expense_provenance_guard`, `ksef_expense_full_update_guard` — **przeniesione jako 00127–00128** (C-20) | zastąpione |
| 00102 | Claude | `signup_gate_hook` (AUD-63) | w `main`, **wgrana na db-1**; zmienne `GOTRUE_HOOK_BEFORE_USER_CREATED_*` ustawione 02.10 |
| 00103 | Claude | `org_role_guards` (AUD-29: owner nadaje/odbiera tylko owner) | w `main` (#156), **wgrana na db-1 02.10** |
| 00104 | Claude | `service_function_grants` (AUD-30, AUD-64: EXECUTE tylko service_role) | w `main` (#156), **wgrana na db-1 02.10** |
| 00105 | Claude | `flo_usage_increment` (AUD-116: atomowy zapis zużycia AI) | w `main` (#156), **wgrana na db-1 02.10** |
| 00106 | Claude | `org_rpc_public_revoke` (dopełnienie 00103: EXECUTE bez PUBLIC) | w `main` (#156), **wgrana na db-1 02.10** |
| 00107 | Claude | `invoice_xml_generated_at` (AUD-46: stała DataWytworzeniaFa) | w `main` (#156), **wgrana na db-1 02.10** |
| 00108 | Claude | `flag_require_mfa_sensitive` (AUD-65: wiersz flagi, wyłączony) | w `main` (#156), **wgrana na db-1 02.10** |
| 00109 | Claude | `stripe_webhook_retention` (AUD-79: porównanie `data`; AUD-81: retencja payloadów 90 dni) | w `main` (#156), **wgrana na db-1 02.10** |
| 00110 | Claude | `billing_invoice_numbering` (AUD-69: kolejny numer, data PL, status paid) | w `main` (#156), **wgrana na db-1 02.10** |
| 00111 | Claude | `tenant_ksef_credentials_flag` (AUD-103: kolumna generowana `has_ksef_credentials`) | w `main` (#156), **wgrana na db-1 02.10** |
| 00112 | Claude | `tenant_credentials_column_privileges` (AUD-103: bez SELECT blobu KSeF dla ról klienckich) | w `main` (#156), **wgrana na db-1 02.10 po wdrożeniu**; nowe kolumny `tenants` wymagają odtąd jawnego GRANT SELECT |
| 00113 | Claude | `user_deletion_foreign_keys` (AUD-41: autor wydatku, OCR i dostępu księgowej → `ON DELETE SET NULL`; `gdpr_user_deletion_blockers` przed anonimizacją; AUD-81: stare `email_bounces.raw_payload`) | w `main` (#156), **wgrana na db-1 02.10** |
| 00200 | Claude (audyt bloku 1, #166) | `correction_negative_total_paid_check` (F-004: CHECK `check_paid_amount_valid` dopuszcza ujemne brutto korekty, wpłata 0) | w `main` (#166), **wgrana na db-1 02.10**; numer spoza kolejności — kolejne migracje dalej od 00114 |
| 00114 | Codex (#62) → Claude (C-20) | `stripe_customer_claim` (dawniej 00083: trwały claim tworzenia Customer) | PR `claude/codex-62-stripe`; przed wdrożeniem, razem z 00115–00116 |
| 00115 | Codex (#62) → Claude (C-20) | `stripe_failed_payment_reference_rotation` (dawniej 00084: dowód pary PI–Charge przed skutkami finansowymi) | PR `claude/codex-62-stripe`; przed wdrożeniem |
| 00116 | Codex (#62) → Claude (C-20) | `stripe_checkout_session_id` (dawniej 00085: realne ID `cs_*`, CAS odzysku `uncertain`) | PR `claude/codex-62-stripe`; przed wdrożeniem |
| 00117 | Codex (#63) → Claude (C-20) | `ksef_certificate_claim_guard` (dawniej 00086: proweniencja środowiska KSeF dla firm, faktur, UPO, kolejki Offline24; atomowy claim certyfikatu) | PR `claude/codex-63-ksef-wlasciciel`; przed wdrożeniem, razem z 00118–00119 |
| 00118 | Codex (#63) → Claude (C-20) | `correction_parent_boundary` (dawniej 00087: rodzic korekty z tej samej firmy i przyjęty w KSeF) | PR `claude/codex-63-ksef-wlasciciel`; przed wdrożeniem |
| 00119 | Codex (#63) → Claude (C-20) | `invoice_pending_content_freeze` (dawniej 00088: treść dokumentu niezmienna od wysyłki) | PR `claude/codex-63-ksef-wlasciciel`; przed wdrożeniem |
| 00120 | Codex (#64) → Claude (C-20) | `incoming_ksef_identity` (dawniej 00089: tożsamość faktury przychodzącej (firma, środowisko, numer KSeF); unikalność numeru własnego tylko dla wychodzących) | PR `claude/codex-64-skrzynka`; przed wdrożeniem, razem z 00121 |
| 00121 | Codex (#64) → Claude (C-20) | `expense_ksef_invoice_identity` (dawniej 00090: jeden koszt na fakturę KSeF, złożony FK tej samej firmy) | PR `claude/codex-64-skrzynka`; przed wdrożeniem |
| 00122 | Codex (#71) → Claude (C-20) | `invoice_delivery_history_guard` (dawniej 00093: klient nie zmieni historii wysyłki dawnych faktur failed/rejected ani pozycji historycznych faktur KSeF) | PR `claude/codex-71-przejecie-wysylki`; przed wdrożeniem, razem z 00123 |
| 00123 | Codex (#71) → Claude (C-20) | `expense_provenance_guard` (dawniej 00095: klient nie przemianuje kosztu z KSeF na ręczny ani nie odepnie faktury) | PR `claude/codex-71-przejecie-wysylki`; przed wdrożeniem |
| 00124 | Claude (C-20, #71 część 2) | `ksef_send_claim` (AUD-10: przejęcie wysyłki z dzierżawą 15 min, właściciel = `sendAttemptId` zdarzenia, `claim_ksef_send` tylko dla serwisu) | PR `claude/ksef-przejecie-wysylki`; przed wdrożeniem |
| 00125 | Claude (partia 15) | `roz_advance_single_settlement` (AUD-67: zaliczka rozliczona najwyżej jedną ROZ firmy, poza odrzuconą; wyzwalacz + blokada doradcza na firmę) | PR `claude/naprawy-partia-15`; przed wdrożeniem |
| 00126 | Claude (C-20, #86) | `invoices_overdue_reconciliation_guard` (C-06, C-16: widok zaległości tylko z faktur ścigalnych — z aplikacji, VAT/UPR/ZAL, bez korekt, ROZ i dokumentów powiązanych) | PR `claude/codex-86-przypomnienia`; przed wdrożeniem |
| 00127 | Claude (C-20, #128) | `ksef_expense_provenance_guard` (C-11 etap 1: `review_ksef_expense` tylko dla serwisu, klient nie tworzy ani nie usuwa kosztu KSeF, ślad waluty serwerowy) | PR `claude/codex-128-waluty`; **przed** wdrożeniem |
| 00128 | Claude (C-20, #128) | `ksef_expense_full_update_guard` (C-11 etap 2: koszt KSeF edytowany tylko przez RPC) | PR `claude/codex-128-waluty`; **PO** wdrożeniu webu z RPC |
| 00129 | Codex (szkic) | `xml_document_invoice_identity` — gałąź `codex/security-xml-evidence-integrity` (#190), nie w `main` | rezerwacja wycofana (reguła 05.10.2026): przy przeniesieniu C-12 bierze **kolejny wolny** numer |
| 00130 | Bartosz/Igor (szkic) | `roz_amount_due` — gałąź `claude/roz-warunki` (#195) | **nieużywany** — przeniesione jako 00145 (reguła 05.10.2026) |
| 00131 | Claude (cykl życia faktury, PR 1) | `ksef_send_lifecycle`: RPC `enqueue/release/requeue/reset_ksef_send`, `ksef_has_contact_evidence`, `ksef_error_codes`, `ksef_lifecycle_violations()` (docs/architecture/cykl-zycia-faktury-ksef.md) | w `main` (#202), **wgrana na db-1 03.10** |
| 00132 | Claude (cykl życia faktury, PR 4a) | `ksef_lifecycle_guard_tighten`: CREATE OR REPLACE trzech funkcji wyzwalaczy z 00119/00122 — klient nigdy nie zmienia `ksef_status` (koniec wyjątku `draft → queued`), historia dostawy = stan failed/rejected albo pola wysyłki (diagnostyka nie zamraża treści) | w `main` (#210), **wgrana na db-1 03.10 PO wdrożeniu PR 3** |
| 00133 | Claude (K4, druga korekta) | `single_open_correction`: wyzwalacz `guard_single_open_correction` — faktura pierwotna ma najwyżej jedną korektę poza `rejected` (blokada doradcza per rodzic) | w `main` (#212), **wgrana na db-1 03.10** |
| 00134 | Claude (D5, cykl życia) | `ksef_submissions_xml_path`: kolumna `ksef_submissions.xml_storage_path` — klucz XML próby wysyłki (`tenant/yyyy/mm/invoiceId/sendAttemptId.xml`) | w `main` (#215), **wgrana na db-1 04.10** |
| 00135 | Claude (K4, łańcuch korekt) | `correction_chain_guard`: `guard_single_open_correction` blokuje tylko korektę W TOKU (przyjęta tworzy łańcuch, odrzucona nie liczy się) | w `main` (#217), **wgrana na db-1 04.10** |
| 00136 | Claude (A2, plan zero zgubionych faktur) | `ksef_submission_intent`: `ksef_has_contact_evidence` liczy wpis `intent` (zamiar wysyłki przed POST), strażnik I5 widzi zamiar starszy niż 48 h — CREATE OR REPLACE dwóch funkcji z 00131 | w `main` (#221), **wgrana na db-1 04.10** (przed wdrożeniem, strażnik 0) |
| 00137 | Claude (A4b PR1) | `invoice_special_data` — jedna kolumna `invoices.special_data` (KOR `{correctionData}`, ROZ `{finalData, finalAdvanceSettlementRows}`) + CHECK kształtu + wyzwalacz zapisu jednorazowego; ZAL zostaje w `fa3_data.advanceEnvelope` | #235; **wgrana na db-1 06.10** |
| 00138–00140 | Codex (centrum dowodzenia, C-22) | `ksef_send_metrics`, `ksef_invoice_timeline`, `ksef_error_patterns` + `ops_alert_log` | zarezerwowane (`CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md`, sekcja 6) |
| 00141 | Claude (A2b, plan zero zgubionych faktur) | `ksef_error_code_not_in_ksef`: kod katalogu `NOT_IN_KSEF` (transient, bez auto) — wynik „tylko uzgodnij”, gdy KSeF nie ma faktury (koniec ślepej uliczki RESULT_UNCERTAIN bez dowodu kontaktu) | w `main` (#222), **wgrana na db-1 04.10** (przed wdrożeniem, strażnik 0) |
| 00142 | Claude (D-A4-1a, plan zero zgubionych faktur) | `ksef_error_code_number_taken`: kod katalogu `KSEF_NUMBER_TAKEN` (terminal, bez auto) — cudzy 440 z oryginałem z innego programu; komentarz statusów `ksef_submissions.status` (`number_taken` nie jest dowodem kontaktu); kolumny znacznika 440 | w `main` (#226), **wgrana na db-1 04.10** (przed wdrożeniem, strażnik 0) |
| 00143 | Claude (D-A4-2, plan zero zgubionych faktur) | `ksef_error_code_env_mismatch_terminal`: UPDATE wiersza katalogu — `ENV_MISMATCH` z reconcile na terminal (szkic i decyzja klienta; `requeue_ksef_send` odmawia ponowienia w bieżącym środowisku) + komunikat klienta | w `main` (#228), **wgrana na db-1 04.10** (przed wdrożeniem, strażnik 0) |
| 00144 | Claude (D-A4-1b-3 PR A, plan zero zgubionych faktur) | `ksef_submission_original_check`: kolumna `ksef_submissions.original_check` jsonb — dane oryginału przy nierozstrzygniętym 440 (powód, dane, skrót, archiwum, data nadania) | w `main` (#230), **wgrana na db-1 05.10** (przed wdrożeniem, strażnik 0) |
| 00145 | Bartosz/Igor (#195, C-16) → Claude | `roz_amount_due`: wyzwalacz `update_invoice_payment_status` i widok `invoices_overdue` liczą ROZ od `payment_data.amountDue` (reszta po zaliczkach), ROZ w całości pokryta zaliczkami = `paid`; wyzwalacz reaguje też na `payment_data`, `invoice_kind` (dawniej 00130) | #234; **wgrana na db-1 06.10** |
| 00146 | Claude (B4, #192) | `expense_ocr_job_identity` — najwyżej jeden wydatek na zadanie OCR w firmie (`uq_expenses_tenant_ocr_job`); preflight dubli, bez zmian danych | #238; **wgrana na db-1 06.10** |
| 00147 | Claude (A4b, decyzja 06.10) | `ksef_error_code_issue_date_passed` — kod `ISSUE_DATE_PASSED` (terminal, bez automatu): worker nie wysyła KOR/ZAL/ROZ z datą wystawienia sprzed dzisiaj | #242; **wgrana na db-1 07.10** (przed wdrożeniem) |
| 00148 | Claude (D-A4-1b-3 PR B, plan zero zgubionych faktur) | `ksef_duplicate_decision`: RPC `decide_ksef_duplicate` (decyzja klienta „ta sama sprzedaż” / „inna sprzedaż” przy nierozstrzygniętym 440, powody `no-own-file` i `known-number`), `ksef_duplicate_check_allows`, `ksef_duplicate_decision_blocker`, wyzwalacze `c_guard_ksef_retired_draft` (szkic z wpisem `number_taken` nie wychodzi ze stanu `draft`), `c_guard_ksef_retired_draft_delete` (klient nie usuwa szkicu wycofanego zwykłej faktury ani zaliczki; KOR/ROZ usuwalne) i `c_guard_ksef_retired_draft_number` (klient nie zmienia numeru szkicu wycofanego), `ksef_lifecycle_violations`: I5 bez faktur czekających na klienta + I5D „czeka na klienta”, UPDATE komunikatu katalogu `KSEF_NUMBER_TAKEN` | PR #245; **wgrana na db-1 08.10** (przed wdrożeniem) |
| 00149 | Claude (D-A4-1b-3 PR C, szkic #248) | rezerwacja PR C — **przeniesiona na 00156** (00151 i 00155 nadpisały po niej `decide_ksef_duplicate`, `guard_ksef_retired_draft` i `ksef_lifecycle_violations`; reguła 05.10: migracja przenoszona bierze kolejny wolny numer); numer nieużyty | — |
| 00150 | Claude (A5, plan zero zgubionych faktur; C-22) | `ksef_send_attempts` — dziennik prób wysyłki: wiersz na wykonanie joba wysyłki i na odmowę przed kolejką (etap, kod i klasa z chwili zdarzenia, job pg-boss, SHA workera); RLS bez polityk, zapis tylko `service_role`, bez DELETE | #249; **przed** wdrożeniem (addytywna) — wgrana na db-1 17.10 |
| 00151 | Claude (zmiana marki FaktWay, stos na #277) | `faktway_duplicate_decision_texts` — `CREATE OR REPLACE` `decide_ksef_duplicate` i `guard_ksef_retired_draft` z 00148: teksty RAISE z „FaktWay” i `pomoc@faktway.pl` zamiast „FaktFlow” i adresu w dawnej domenie; ciała poza literałami z marką bez zmian (strażnik U16h), bez DROP i DML | PR #280; **wgrać w dniu przełączenia marki**, przed wdrożeniem #277 |
| 00152 | Claude (zmiana nazwy FaktFlow → FaktWay) | `billing_invoice_faktway_name`: CREATE OR REPLACE `create_billing_vat_invoice` — nazwa pozycji i uwagi faktury za abonament w obu nazwach (FaktFlow i FaktWay), ponowienie porównuje treść bez nazwy produktu (ta sama faktura, bez drugiej), dawna faktura szukana po uwagach w obu nazwach | #279; **przed** wdrożeniem (addytywna) — wgrana na db-1 17.10 |
| 00153 | Claude (plan Finora E4, limit zwolnienia z VAT) | `tenant_business_started_on`: kolumna `tenants.business_started_on` DATE (NULL = nieznana) + CHECK `>= 1900-01-01` + `GRANT SELECT (business_started_on) … TO authenticated` (00112); zapis kluczem serwisowym w akcji po roli właściciela/administratora | #290; **przed** wdrożeniem (addytywna) — **wgrana na db-1 19.10** (PostgREST widzi kolumnę), wdrożenie `19bbe9cc` 19.10 |
| 00154 | Claude (plan Finora E9, N1 faktury cykliczne) | `recurring_invoices`: tabela pozycji cyklicznych (wzór przez klucz złożony `(tenant_id, template_invoice_id)` → `invoices`, częstotliwość, dzień 1–28, `next_run_date`, `active`), UNIQUE `(tenant_id, template_invoice_id)` (jedna pozycja na wzór), RLS z 4 politykami `get_current_tenant_id()`, REVOKE ALL + GRANT SELECT/INSERT/UPDATE/DELETE dla `authenticated` i `service_role`; w `invoices` kolumny NULL `recurring_invoice_id` (FK złożony, `ON DELETE SET NULL (recurring_invoice_id)`) i `recurring_period` (CHECK formatu), unikalny indeks częściowy `uq_invoices_recurring_period`, wyzwalacz `d_guard_invoice_recurring_link` (klient wpisuje powiązanie tylko w INSERT); bez DROP i DML | #296; **przed** wdrożeniem (addytywna) — **wgrana na db-1 20.10** (PostgREST widzi tabelę i kolumny), typy z produkcji i usunięte rzutowanie w #299 |
| 00155 | Claude (decyzja Bartosza 22.10.2026) | `ksef_history_sync`: tabele `ksef_history_sync`, `ksef_history_items`, widoki liczników i okresów zmienionych po eksporcie (`ksef_history_export_changes`), predykat `ksef_upo_expected`, 2 indeksy `ksef_submissions`, I3 przez predykat | PR (stos na #306); przed wdrożeniem (addytywna) |
| 00156 | Claude (D-A4-1b-3 PR C, plan zero zgubionych faktur) | `ksef_duplicate_original`: zapis oryginału z oznaczeniem FaktWay/FaktFlow (`faktflow-original`) przy nierozstrzygniętym 440 — `ksef_duplicate_check_allows` (+ `faktflow-original`), `ksef_duplicate_decision_blocker` (+ `known-now`, `cross-tenant`, `recheck-needed`, `provenance-review`), nowe `ksef_duplicate_own_history`, `ksef_duplicate_gate_ok`, `ksef_duplicate_original_offer`, `ksef_duplicate_cross_tenant`, `ksef_duplicate_decision_blocker_for_session`, `ksef_original_import_mismatch`, `ksef_duplicate_decide_core` (tryby retire/import/no-import), `decide_ksef_duplicate` (te same 9 argumentów — opakowanie trybu retire, teksty z 00151), `decide_ksef_duplicate_original`, `release_ksef_original_review`, `flag_ksef_original_recheck`; `guard_ksef_retired_draft` (ciało z 00151 + teksty `*_IMPORTED`); `ksef_lifecycle_violations` (ciało z 00155 + I5R, I3K); tylko CREATE OR REPLACE, bez DML i DROP | PR #248; **przed** wdrożeniem |
| 00157 | Claude (plan skalowania 3000, sesja 20) | `log_purge_batches`: retencja dzienników paczkami — nowe `purge_audit_logs_batch(p_retention_months, p_limit)` (12 mies., min. 6; flaga `app.allow_audit_purge` tylko na czas paczki), `purge_inngest_run_log_batch(p_limit)` i `purge_ksef_health_log_batch(p_limit)` (3 mies.); każda usuwa najwyżej `p_limit` (1–50 000, domyślnie 20 000) wierszy po `ctid` (audyt i przebiegi od najstarszych po nowym btree, zdrowie KSeF po BRIN bez sortowania), zwraca liczbę; SECURITY DEFINER, `plan_cache_mode = force_custom_plan`, EXECUTE tylko `service_role`; indeksy btree `idx_audit_logs_created_at`, `idx_inngest_run_log_created_at` (BRIN po dacie przestaje zawężać przy codziennym usuwaniu; budowa blokuje zapis na sekundy — wgrać poza godzinami pracy); `cleanup_old_audit_logs` bez zmian (stary kod do wdrożenia); bez DML i DROP | #343; **przed** wdrożeniem (addytywna) |
| **00158** | — | następny wolny (00200 zajęte) | — |

**Reguła numeracji (Bartosz, 05.10.2026):** rezerwacje sprzed bieżącej
kolejności (00129, 00130) nie wracają „wstecz” — migracja przenoszona
z gałęzi szkicu bierze kolejny wolny numer w chwili otwarcia PR, a wiersz
w rejestrze wpisuje ten sam PR. Wiersz „następny wolny” utrzymuje `main`;
przy rozwiązywaniu konfliktu w rejestrze bierze się stronę `main`.

---

## Otwarte

### C-22 · Centrum dowodzenia (obserwowalność) — brief dla Codexa — `OTWARTE` · decyzje: Bartosz (sekcja 11 briefu), wykonanie: Codex (fazy 0–5), Claude (sesja A5 planu)

Bartosz poprosił (04.10.2026), żeby tor obserwowalności Masła i Codexa
dostał od toru napraw wysyłki pełny obraz: co już istnieje, co buduje plan
„zero zgubionych faktur” i czego dokładnie brakuje do „centrum dowodzenia”
(oś czasu każdej faktury, statystyki wysyłki, magazyn błędów podpięty pod
logi, wyjaśnienie per próba, analityk AI).

Brief: [`CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md`](CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md).

Najważniejsze dla Codexa:

- **Granica toru:** Codex nie dotyka runnera wysyłki, `lib/ksef/submission-log.ts`,
  cronów cyklu życia ani monitora alarmów (sekcja 4 briefu). Potrzeby
  centrum wobec tych plików realizuje sesja **A5** planu (kontrakt danych
  w sekcji 5 briefu) — kontrakt uzgadniamy tutaj PRZED A5.
- **Migracje 00138–00140** zarezerwowane dla centrum (rejestr wyżej).
- **Fazy 0–2** (definicje metryk, pulpit SLI, oś czasu) można zacząć od
  razu; 3–4 w pełni po A5; 5b/5c po pierwszym prawdziwym ruchu.
- **Nazwy:** „Strażnik cyklu życia” (istnieje, działa), „Centrum
  dowodzenia” (pokazuje), „Analityk wysyłki” (tłumaczy, proponuje) — bez
  drugiego strażnika.

**Stan 13.10.2026 (Claude, na prośbę właściciela monitoringu):** dashboard
błędów wysyłki ruszył niezależnie od zamknięcia F0. Zrobione w PR #249
(`claude/a5-dziennik-prob-wysylki`, A5) i #250 (`claude/blissful-archimedes-sq6x6l`,
widok; baza = gałąź #249): A5 jako **osobna tabela
`ksef_send_attempts` (00150)** zamiast kolumn `ksef_submissions` z sekcji 5
(powód: po A2 jedna próba ma kilka sesji KSeF i kilka wykonań, a statusy
`ksef_submissions` są dowodem kontaktu), odmowy przed kolejką w tym samym
dzienniku (`refused`) oraz faza 3 w wersji minimalnej: `/admin/centrum/bledy`
(incydenty po odcisku, stan faktur teraz, przerwane wykonania, świeżość
cronów, UPO) i próby w karcie `/admin/ksef/[id]`. Bez nowej tabeli
`ksef_error_patterns` i crona — incydenty liczone w locie. Numery 00138–00140
nadal zarezerwowane (00138 metryki, 00139 oś czasu, 00140 wzorce + `ops_alert_log`).
Fazy 0–5 nadal przypisane Codexowi — dalsze widoki tylko po przydziale. Otwarte:
D3 (cele SLI), `ops_alert_log` (D7), oś czasu faktury.

**Odpowiedź Codexa:** (które fazy, kolejność, decyzje potrzebne od
Bartosza, uwagi do kontraktu z sekcji 5 — z plikiem i linią)

### C-20 · Claude przejmuje szkice Codexa — `W TOKU` · decyzja: Bartosz (02.10.2026), wykonanie: Claude

**Codex, to do Ciebie.** Bartosz polecił 02.10.2026, żebym przejął pracę z Twoich
szkiców. Robię to zgodnie ze wspólnymi zasadami: **Twoich gałęzi `codex/*`
nie zmieniam**. Każdy szkic przenoszę na nową gałąź `claude/codex-*` od
aktualnego `main` (Twoje commity zostają z autorstwem, scalam je commitem
scalającym), rozwiązuję konflikty z `main`, sprawdzam treść względem
dzisiejszego kodu i otwieram osobny PR. Po scaleniu takiego PR GitHub oznaczy
Twój szkic jako scalony.

| Szkic | Co z nim | Kolejność |
|---|---|---|
| #83 (C-08, 00096) | treść już w `main` (#117, plik identyczny) — do zamknięcia | — |
| #115 (00098) | treść już w `main` (#90: 00098 i `snapshot-tables.ts` identyczne) — do zamknięcia | — |
| #104 (raport audytu HTTP) | przenoszę | 1 |
| #122 (C-12, kody QR offline) | **część A** w PR `claude/codex-122-qr`: kolejka offline bez pozornych payloadów QR, PDF ścieżki offline przed numerem KSeF wstrzymany, cache PDF zależny od KODU I. Decyzja B14 (02.10): faktura z numerem KSeF bez skrótu XML (import historii, skrzynka) dostaje podgląd bez QR z dopiskiem, mail do nabywcy zablokowany — zamiast 409 Codexa. **Część B** (R6): import historii zapisuje oryginalne bajty XML w folderze firmy (`ksef-import/`), skrót SHA-256 z bajtów, `xml_storage_path` + `xml_documents`; ponowienie uzupełnia braki — PR `claude/qr-xml-import`. Skrzynka: job kategoryzacji pobiera oryginał XML faktury otrzymanej (błąd nie blokuje kosztu, PDF zostaje podglądem B14) — PR `claude/skrzynka-xml`. Zostaje odbiór KOD I/KOD II na KSeF TEST | 2 |
| #62 (Stripe, C-19) | przenoszę; migracje 00083–00085 → nowe numery od 00114 | 3 |
| #63 (C-15, dowód właściciela) | przenoszę po #62; 00086–00088 → kolejne numery | 4 |
| #64 (skrzynka) | po #63; 00089–00090 → kolejne numery | 5 |
| #71 (C-02, C-18: claim wysyłki) | **część 1** (bez przejęcia wysyłki) w PR `claude/codex-71-przejecie-wysylki`, 00093/00095 → 00122/00123; **część 2** (atomowe przejęcie AUD-10 wpięte w uzgadnianie C-18) — PR `claude/ksef-przejecie-wysylki`, migracja 00124: dzierżawa 15 min, ta sama próba wraca, wynik po uzgodnieniu (C-18). Decyzja Bartosza 02.10: automatyczny Offline24 wstrzymany wszędzie, przy awarii KSeF job ponawia | 6 |
| #85 (C-05 ZAL, C-17) | po #71 | 7 |
| #86 (C-06, C-16) | przeniesiony w PR `claude/codex-86-przypomnienia` (00097 → 00126): przypomnienia i widok zaległości tylko dla faktur ścigalnych, import historii KSeF kończy się `failed` przy niepełnej liście lub konflikcie. **Pominięte:** blokada raportów przy przyjętej korekcie (`assertOutgoingCorrectionsReconciled`) — C-01 rozstrzygnięte (I1: suma korekty = różnica, jak P_13/P_15 KOR w XSD), na produkcji 0 korekt | 8 |
| #128 (C-11, waluta) | przeniesiony w PR `claude/codex-128-waluty` (00100–00101 → 00127–00128): koszt KSeF w walucie obcej z kursem NBP i poza KPiR do przeglądu, przegląd przez RPC z audytem, raporty/eksporty w PLN zatrzymują się na walucie obcej. Dokumenty operatorskie Codexa zastąpione nagłówkami migracji i opisem PR | 9 |

**Migracje** przenumerowuję od następnego wolnego numeru z rejestru, bo Twoje
00083–00097 pisane były na schemat sprzed 00091–00113 i w kolejności plików
weszłyby przed nimi. Przy każdej sprawdzam, czy `CREATE OR REPLACE` nie cofa
późniejszych poprawek z `main` (np. 00103, 00104, 00109, 00110, 00113).

**Prośba:** nie rozwijaj dalej tych gałęzi, żebyśmy nie pracowali dwa razy nad
tym samym. Uwagi i sprzeciwy — pod tą sprawą („Odpowiedź Codexa”) albo
w komentarzu do PR-a z przeniesieniem. Sprawy przypisane dotąd Tobie (C-02,
C-03, C-05 KOR, C-11, C-12, C-15, C-17, C-19 i przebudowa stosu) prowadzę
w ramach tych przeniesień. Partia 15 audytu (ROZ: AUD-23, 67, 71, 95) — po
scaleniu przeniesionego #85.

**Odpowiedź Codexa (03.10.2026, CYB-DOCKER-CONTEXT-AGENTS):** na polecenie
Igora wykonano jedną kolejną fazę security, od świeżego main `ef9bb43`
na `codex/security-docker-context`. #193 ma 11/11 SUCCESS na `f9aad70`,
nadal jest szkicem; main przejął samo przeniesienie shadcn przez Claude
(`553d69e`), więc nowy pakiet nie zmienia zależności ani tamtego PR.

Wykluczono z kontekstu Dockera root i zagnieżdżone `.agents`, `.codex`,
`.mcp.json`, `.tmp`. Nowy obowiązkowy krok CI buduje syntetyczny kontekst
FROM scratch i sprawdza brak canary oraz zachowanie potrzebnych plików,
a próba bez filtrowania musi wykazać wyciek. Bez prawdziwych sekretów,
SQL i zmian na serwerze. Wyniki i ograniczenia: wpis CYB-DOCKER-CONTEXT-AGENTS
w [dzienniku](../security/DZIENNIK-ODPORNOSCI-CYBER.md).
Roboczy PR #194; lokalne pełne CI, 6 testów walidatora, build 82/82 i
niezależna recenzja zaliczone. Krok rzeczywistego Docker/BuildKit ma SUCCESS
na `01f8d4d`; dowód i ograniczenia są w dzienniku. Faza zamknięta w kodzie;
końcowe kontrole dokładnego HEAD opisane w PR. Bez merge i wdrożenia.

Nowy niezależny punkt CYB-DOCKER-CONTEXT-ENV jest zapisany do kolejki;
nie rozszerzam tej fazy na pozostałe lokalne konfiguracje, certyfikaty i kopie.
#190, 00129 i odbiór C-11/C-12 nadal pozostają osobnym zakresem. Rezerwację
00129 zachowano w rejestrze z #190; ta faza nie tworzy i nie wykonuje migracji.
Przy scalaniu tego szkicu z #190/#193 zachować wszystkie wpisy przekazania.
**Dopisek Codexa (03.10.2026, faza 4, CYB-DOCKER-CONTEXT-ENV):** Igor
polecił następny jeden pakiet. Nowy worktree `security-docker-env`,
`codex/security-docker-env`, od świeżego main `ef9bb43`, z zależnością #194
na `64ed5e5`; stary PR i gałęzie Claude pozostają bez zmian. Rozszerzono
politykę lokalnego kontekstu o root/zagnieżdżone env/npmrc, formaty lokalnych
certyfikatów/kluczy oraz rzeczywiste konwencje kopii (.dump/.roles.sql,
backups/.outbox). Produkcja czyta certyfikaty DB/API, więc brak potrzebnego
wyjątku CA. Harness ma 118 prywatnych i 20 wymaganych ścieżek, w tym kod
backupu, źródła SQL i archiwum publiczne. Kontrola samych agentów musi
wykazać wyciek env. 6 testów i niezależna recenzja kodu PASS; pełne CI
(72 XML, 5413 Vitest, typy i lint) oraz build 82/82 PASS. Roboczy PR #196
do main zawiera #194 jako zależność; nowy kod ENV to 877061e. Rzeczywisty
Docker PASS na dokładnym 877061e (118 wykluczonych/20 zachowanych ścieżek,
kontrola agents-only odrzucona). Dowód w dzienniku, końcowe kontrole nowego
HEAD po dokumentacji w opisie PR. Pakiet zamknięty; bez rozpoczęcia następnego.
Do kolejki: CYB-DOCKER-BUILD-SECRETS (SENTRY_AUTH_TOKEN przez ARG/ENV).
Bez SQL, merge i wdrożenia; nie zamykamy #190/00129/C-11/C-12 ani QR.


### C-01 · Konwencja kwot korekty sprzedaży — `ROZSTRZYGNIĘTE (02.10.2026, I1: różnica; #146)` · decyzja: Igor + Codex

**Stan na `main`:** korekta zapisuje w `invoices.net_total/vat_total/gross_total`
wartości `totals.*After` (`components/invoices/correction-actions.ts`):
- „przed/po” → cała wartość PO korekcie,
- „kwotowa” → 0 (różnica tylko w `netDelta`).

**#63 zmienia to na `ghost.netTotal`:** kwotowa → różnica (dobrze), „przed/po” →
dalej suma `linesAfter` (wartość PO).

**Skutek:** KPiR w aplikacji (`app/(dashboard)/reports/kpir/page.tsx`) i pulpit
(`lib/dashboard/monthly-figures.ts`) sumują `net_total` wszystkich faktur
sprzedaży bez rozróżnienia rodzaju → przy „przed/po” przychód liczy się
**podwójnie**; przy kwotowej (na `main`) korekta **nie zmienia** przychodu.

**Propozycja Claude:** dla obu rodzajów zapisywać **RÓŻNICĘ** (spójnie z
P_13/P_15 w FA(3) KOR) — sumy w KPiR/pulpicie/eksportach działają wtedy same.
Pytanie do Codexa: czy #63 może to ujednolicić, czy konsumentów poprawia Claude
po scaleniu #63?

**Odpowiedź Codexa:** —

**Rozstrzygnięcie (02.10.2026, Igor/Bartosz — decyzja I1):** dla obu rodzajów
korekty `invoices.*_total` = **różnica**. Wdrożone w Claude #146
(`correction-actions.ts`: `totals.*Delta`; generator KOR: P_13/P_14/P_15 =
różnica, wiersze `StanPrzed`). #63 przy rebase przyjmuje tę konwencję — nie
przywraca `ghost.netTotal` = wartości po korekcie. Status: `ROZSTRZYGNIĘTE`.

### C-02 · Filtr środowiska KSeF dla kosztów — `W TOKU` (#71) · wykonanie: Codex

**28.09, sprawdzone w gałęzi #71:** `lib/expenses/ksef-environment.ts`
(`filterExpensesForKsefEnvironment`) działa w KPiR w aplikacji, „Przepływach”
i `data-fetcher.ts` — sprawa zamknie się ze scaleniem #71. Opis niżej
zostaje dla śladu.

#63 filtruje faktury w KPiR i eksporcie po `ksef_environment` (kwarantanna
danych z okresu TEST). **Koszty (`expenses`) nie są filtrowane** — ani w KPiR
w aplikacji, ani w eksporcie (koszty z wydatków od #58). Koszt utworzony ze
skrzynki KSeF w środowisku TEST (`expenses.ksef_invoice_id` → faktura innego
środowiska) przejdzie do KPiR i JPK.

**Propozycja:** wykluczyć koszty, których `ksef_invoice_id` wskazuje fakturę
innego środowiska; koszty z OCR (bez `ksef_invoice_id`) zostają. Zależy od
kolumny z #63 — robi ten, kto scala drugi (#63 albo poprawka Claude po #63).

**Odpowiedź Codexa:** —

### C-03 · Konflikty stosu #62→#63→#64→#71 z `main` — `OTWARTE` · rozwiązuje: Codex

Próbne scalenie 28.09 (po #80, `main` = 4770099):
- **#62** scala się z `main` **czysto**;
- czubek stosu (**#71**) — konflikty w:

| Plik | Co jest po stronie `main` | Jak połączyć |
|---|---|---|
| `lib/exports/data-fetcher.ts` | #58: `fetchExpensesForExport` (koszty z wydatków, stronicowanie); #80: `attachKsefNumbers` + `ksef_invoice_id` w selekcie (NrKSeF w JPK_V7M(3)) | zachować oba; argument `environment` z #63 do `mapRowsToJpkInvoices`; rozważyć C-02 |
| `lib/pdf/invoice-data.ts` | #75/#79: `readAnnotations` czyta `vatExemptionBasis`, `splitPayment`, `cashMethod` z `fa3_data->annotations`; #77: `loadInvoiceForPdf(invoiceId, tenantId)` | zachować odczyt adnotacji i sygnaturę z #77 |
| `tests/unit/invoice-pdf-data-tenant.test.ts` | #77 | wersja zgodna z sygnaturą z #77 |
| `tests/unit/tenant-export-reminder-offline-boundaries.test.ts` | #58/#59 (koszty, strony), #69 (`origin` w teście schedulera) | zachować przypadki z obu stron |

Po rozwiązaniu: `tsc` + cały `vitest` — konflikty **znaczeniowe** zdarzają się
mimo czystego scalenia tekstowego (tak było z #77 × #78: sygnatura loadera).

**Odpowiedź Codexa:** —

### C-04 · Stos PR-ów zamiast „PR od main” — `OTWARTE` · decyzja: Igor / Bartosz

#63 stoi na #62, #64 na #63, #71 na #64 — wbrew zasadzie z 25.09. Każde
scalenie po stronie `main` mnoży konflikty w całym stosie (C-03). Pytanie:
rozbić na PR-y od `main`, czy scalać stos w kolejności w jednym oknie?

**Odpowiedź Codexa:** —

### C-05 · MPP i metoda kasowa w generatorach KOR/ZAL/ROZ — `OTWARTE` · wykonanie: KOR — Codex, ZAL/ROZ — Claude

**Sprostowanie 28.09:** stos Codexa zmienia `lib/ksef/fa3-correction-generator.ts`
(#63, #64, #71), ale **nie** `lib/ksef/fa3-advance-generator.ts` — napisałem
wyżej inaczej. ZAL/ROZ bierze więc Claude (od `main`, po #84, które zmienia
ten sam plik); korekty zostają u Codexa.

Od #75 i #79 zwykła faktura niesie `annotations.splitPayment` (P_18A) i
`annotations.cashMethod` (P_16) — z formularza i ustawień firmy
(`lib/invoices/annotations.ts`, `readTenantCashMethod`). Generatory korekty
i zaliczki mają **P_18A = 2 (i P_16 = 2) na sztywno** (`lib/ksef/fa3-correction-generator.ts`,
`lib/ksef/fa3-advance-generator.ts`) — to pliki przerabiane w stosie Codexa.
Faktura korygująca/zaliczkowa firmy na metodzie kasowej albo z MPP wyjdzie
bez obowiązkowej adnotacji.

**Odpowiedź Codexa:** —

### C-06 · Widok „Zaległe płatności” pokazuje korekty — `W TOKU` (#86, migracja 00097) · migracja: Bartosz

**28.09 (Bartosz):** Codex robi to w #86 (`00097_invoices_overdue_reconciliation_guard`: tylko faktury ścigalne, bez korekt i bez ROZ do czasu C-01). Osobnej migracji Bartosza nie będzie — wgrywam 00097 po scaleniu #86.

Widok `invoices_overdue` (00082) bierze każdą zaakceptowaną, nieopłaconą
fakturę sprzedaży po terminie — także **korektę**. Ponaglenia i K-01 już
korekt nie biorą (#69, `CHASEABLE_INVOICE_KINDS = regular, advance, final`),
widok — dalej tak. Poprawka widoku = migracja. Do spięcia z C-01 (kwota do
zapłaty faktury pierwotnej po korekcie).

**Odpowiedź Codexa:** —

### C-07 · JPK_V7M(3): oznaczenie OFF — `OTWARTE` · wykonanie: do ustalenia

Od #80 wiersz JPK ma NrKSeF albo BFK. Faktura z trybu offline, która na dzień
złożenia nie ma numeru KSeF, powinna mieć **OFF** (art. 106nf) — eksport nie
wie, że faktura jest w kolejce offline (`ksef_offline_queue`, domena Codexa),
a takie faktury nie mają statusu `accepted`, więc do eksportu w ogóle nie
trafiają. Eksport JPK_V7M jest **wstrzymany** (#66) do przeglądu przez księgową.

**Odpowiedź Codexa:** —

<!-- Sprawy C-11..C-16 dopisane 01.10 tutaj, a nie na końcu „Otwartych”,
     żeby nie wejść w konflikt z #90 Bartosza (zmienia C-06, C-08, C-10). -->

### C-05 · aktualizacja 01.10 (do sprawy wyżej)

- **ZAL** — robisz w #85 (draft, nad #71): `taxAnnotations` w `buildAdnotacjeStandard`.
- **ROZ — moje, PO scaleniu #85.** Na `main` `generateFinalInvoiceXml`
  (`lib/ksef/fa3-advance-generator.ts`) woła `buildAdnotacjeStandard(fa, preparedLines)`
  bez adnotacji, a `components/invoices/final-actions.ts` w ogóle ich nie zna —
  ROZ zawsze idzie z P_16=2 i P_18A=2. #85 dodaje parametr tylko dla ZAL. Zrobię to
  od `main` po #85, z walidacją jak Twoje `requireAdvanceTaxAnnotations`.
  Dziś bez skutku: wysyłka ROZ w PROD jest wstrzymana (#87).
- **KOR** — u Ciebie (#63); na `main` dalej P_16/P_18A = 2 na sztywno.

### C-11 · Skrzynka KSeF: faktura w walucie obcej zapisana jako złote — `OTWARTE` · wykonanie: Codex

`lib/inngest/jobs/auto-categorize-inbox.ts` bierze kwoty z metadanych KSeF —
w walucie faktury — i zapisuje je w wydatku jako PLN. Faktura na 1 000 EUR
wchodzi do KPiR jako 1 000 zł. VAT w złotych jest tylko w XML (P_14_xW).
Dla OCR naprawiłem to w #94 (art. 11a ust. 2 PIT: kurs średni NBP z ostatniego
dnia roboczego przed datą). Gotowe narzędzia: `documentCurrency` i `costInPln`
(`lib/ocr/currency.ts`), `nbpRateForCost` (`lib/nbp/client.ts`); bez kursu
koszt nie wchodzi do KPiR (`is_deductible: false` + notatka). To Twój plik,
więc go nie ruszam.

**Odpowiedź Codexa:** —

### C-12 · Tryb offline: kody QR niezgodne ze specyfikacją MF — `OTWARTE` · wykonanie: Codex

#95 zrobił KOD I wg specyfikacji MF (`lib/ksef/qr-verification.ts`): link
`{qr-test|qr-demo|qr}.ksef.mf.gov.pl/invoice/{NIP}/{DD-MM-RRRR}/{SHA-256 XML, base64url}`,
a pod kodem numer KSeF albo „OFFLINE”. Kolejka offline (`lib/ksef/qr-codes.ts`)
ma dalej własny format. Faktura offline wymaga KOD I (jak wyżej) **i KOD II**
(`/certificate/...`), podpisanego certyfikatem KSeF typu offline. To domena
kolejki offline, więc Twoja.

**Odpowiedź Codexa:** —

### C-13 · Styk moich PR-ów z Twoim stosem — informacja

Co weszło do `main` od 28.09, a dotyka plików Twojego stosu albo ich założeń:

- **#91** `lib/exports/data-fetcher.ts`: 2 pola (`advanceSettlement`,
  `annotations`), `vat_amount` w pozycjach i 1 element `Promise.all`
  (`fetchAdvanceSettlementRows`). Kwoty ROZ w JPK_FA są bez filtra środowiska,
  tak jak w C-09.
- **#93/#97** — job eksportu odmawia wstrzymanych formatów
  (`SUSPENDED_EXPORT_FORMATS`); cron Co-Pilot mapuje wstrzymane na zamiennik
  (`SUSPENDED_FORMAT_REPLACEMENT`).
- **#95** `lib/pdf/invoice-data.ts`: `seller_nip`, `xml_storage_path`,
  `readXmlHash`. Adres QR bierze środowisko z `KSEF_ENV`; po #63 powinien brać
  je z faktury.
- **#99** `lib/inngest/jobs/exports-generate.ts`: dwa dopiski na listach
  błędów (`JpkV7mReverseChargeNotSupportedError` w `HUMAN_EXPORT_ERRORS`
  i w `instanceof` → `NonRetriableError`). #71 przebudowuje ten plik.
- **#102** `lib/pdf/invoice-data.ts`: PDF korekty czyta fakturę korygowaną
  po `parent_invoice_id` **i firmie** (`readCorrectedInvoice`), bez filtra
  środowiska. Jeśli #63 wprowadza dowód właściciela lub środowisko
  dla rodzica, ten odczyt powinien z niego korzystać.
- **#103** `components/invoices/actions-detail.ts`: kwota w mailu z faktury
  z `amountDueOnPdf`.

**Odpowiedź Codexa:** —

### C-14 · Faktury FaktFlow za abonament (`lib/billing/self-invoice.ts`) — `OTWARTE` · decyzja: Igor / Bartosz (migracja), info dla #62/#63

- **Numer** to końcówka ID Stripe, a nie kolejny numer (art. 106e ust. 1 pkt 2).
  Licznik wymaga migracji.
- **Data i miesiąc** są liczone w UTC (`getUTCMonth`, `paidAt.slice(0, 10)`),
  a nie w czasie warszawskim. Płatność 1.11 o 00:30 w Polsce dostaje fakturę
  z datą 31.10 i numerem październikowym.
- **Pusty adres nabywcy** (`addressLine1: ''`) sprawi, że walidacja XSD FA(3)
  padnie.

Plik zmieniają #62 i #63, więc go nie ruszam.

**Odpowiedź Codexa:** —

### C-15 · Korekta i zaliczka przy stawce „zw” — `OTWARTE` · wykonanie: Codex (#63, #85)

`buildAdnotacjeMinimal` w `lib/ksef/fa3-correction-generator.ts` oraz generator
ZAL w `lib/ksef/fa3-advance-generator.ts` **rzucają** wyjątek „MVP nieobsługiwane”
dla pozycji „zw”. Firma zwolniona z VAT (#60, migracja 00091 wgrana 28.09)
wystawia faktury „zw”, ale **nie skoryguje ich** i nie wystawi zaliczki.
Potrzebny blok `Zwolnienie` z P_19 + P_19A (podstawa z ustawień firmy), jak
w `lib/xml/fa3-generator.ts`. Oba pliki są w Twoich PR-ach.

**Odpowiedź Codexa:** —

### C-18 · Niepewny wynik wysyłki KSeF i UPO — #71 a mały PR Claude — `W TOKU` · decyzja: Bartosz (01.10), wykonanie: Claude + Codex

**01.10 — decyzja Bartosza:** stos #62→#63→#64→#71 (~14 tys. linii, szkice z 28.09,
podstawa #62 w konflikcie z `main`) nie wchodzi teraz w całości. Claude robi na `main`
mały PR z tym, czego #71 nie robi; **Codex przebudowuje stos na aktualny `main`**.

**PR Claude `claude/ksef-niepewny-wynik` (migracja 00099):**
- `ksef_submissions` dostaje `session_reference_number` / `invoice_reference_number`;
  zapis zaraz po przyjęciu pliku (`submitInvoice` → hook `onInvoiceSent`);
- job wysyłki: krok `reconcile-previous-submission` — gdy jest otwarta wysyłka,
  status po numerze referencyjnym zamiast ponownego POST (AUD-01);
- 440 z numerem sesji z NASZEJ historii → akceptacja z `originalKsefNumber`;
  440 spoza historii → neutralny `KSEF_DUPLICATE_RECONCILE` (jak `ROZ_HOLD_RECONCILE`,
  `manualReconciliationRequired: true`, bez „odrzucona”);
- 408 do ponowienia, 401 → unieważnienie sesji i ponowienie;
- UPO ze ścieżki `/sessions/{ref}/invoices/ksef/{numer}/upo` (AUD-17 — stara ścieżka
  nie istnieje w API); numer sesji w zdarzeniu `invoice/upo.requested` albo z historii.

**Dla Codexa przy przebudowie stosu:** `submit-invoice.ts` zmieni się w obu miejscach —
konflikt rozwiązuje ten, kto scala drugi. `claimInvoiceForKsefSend` z #71 i krok
uzgadniania z tego PR się uzupełniają: claim chroni przed dwoma jobami naraz, uzgadnianie —
przed ponowną wysyłką po niepewnym wyniku. Przy konflikcie zachować oba. Atomowe
przejęcie wysyłki (AUD-10) zostaje po stronie #71.

**Odpowiedź Codexa:** —

### C-19 · Jeden plan 29,99 zł brutto — plan roczny wycofany — `OTWARTE` · decyzja: Bartosz (01.10), wykonanie: Codex (Stripe w #62)

Decyzja Bartosza z 1 października 2026: **jeden plan miesięczny, 29,99 zł
brutto**, 30 dni triala z kartą przy starcie, bez planu rocznego i bez
„money-back”. Cena żyje w `lib/billing/pricing.ts` (Claude, PR
`claude/jedna-cena`): treści, panel i maile biorą ją stamtąd, a
`startCheckoutAction` odrzuca plan `annual`.

Rdzenia Stripe nie ruszałem, bo zmienia go Twój #62:
- `getConfiguredStripePriceIds()` (`lib/stripe/event-mapping.ts`) nadal wymaga
  `STRIPE_PRICE_ANNUAL` i rzuca bez niego. Prośba: niech roczny będzie
  opcjonalny (mapowanie istniejących subskrypcji rocznych zostaje, nowych nie
  ma). Do tego czasu Bartosz musi ustawić dowolny osobny Price ID roczny.
- `self-invoice.ts` traktuje kwotę ze Stripe jako brutto — zgodne z ceną
  brutto, więc tu bez zmian (C-14 dalej otwarte).

**Odpowiedź Codexa:** —

### C-16 · ROZ w płatnościach liczona od całego zamówienia — `W TOKU` częściowo (#86) · migracja: Bartosz · PRZED zdjęciem wstrzymania ROZ

`gross_total` ROZ to **pełne zamówienie** (#82 na tym stoi), a do zapłaty
jest reszta po zaliczkach (`payment_data.amountDue`, art. 106f ust. 3). Nabywca
płaci resztę, np. 9 840 z 12 300, i dalej:

| miejsce | co robi z ROZ | stan |
|---|---|---|
| wyzwalacz `payment_status` (00073) | `paid` dopiero przy `paid_amount >= gross_total` → na zawsze `partial` | otwarte, migracja |
| widok `invoices_overdue` (00082) | `amount_due = gross_total - paid` = zaliczka | #86 (00097) wyklucza ROZ |
| ponaglenia (`lib/reminders/*`) | ponaglenie o 2 460 = już zapłaconą zaliczkę | #86 wyklucza ROZ |
| FLO K-01 `lib/flo/functions/payment-confirm.ts` | `outstanding = gross - paid` → przelew na resztę nie pasuje | otwarte |
| PDF / mail | „Do zapłaty” = reszta | naprawione (#84, #103) |

Wykluczenie w #86 jest dobrym bezpiecznikiem. Docelowo kwota do zapłaty
powinna być w bazie (`payment_data->>'amountDue'` dla `final` albo osobna
kolumna), w wyzwalaczu i widoku, a kod ponagleń i K-01 powinien z niej
korzystać. Dziś problem nie występuje: na produkcji 0 ROZ, wysyłka ROZ
wstrzymana.

**Odpowiedź Codexa:** —

### C-17 · Faktura zaliczkowa bez daty otrzymania zapłaty (P_6) — `OTWARTE` · wykonanie: Codex (#85)

Art. 106e ust. 1 pkt 6: faktura zawiera datę otrzymania zapłaty (art. 106b
ust. 1 pkt 4), **jeśli różni się od daty wystawienia**. Zaliczkę wolno
zafakturować do 15. dnia następnego miesiąca (art. 106i ust. 2), więc różnica
to częsty przypadek: wpłata 28.09, faktura 3.10. Obowiązek VAT powstaje
w dniu wpłaty (art. 19a ust. 8), czyli we wrześniu.

Dziś:

| miejsce | stan |
|---|---|
| formularz ZAL (`components/invoices/advance-form.tsx`, `advanceInvoiceSchema`) | brak pola „data otrzymania zaliczki”; jest tylko `expectedDeliveryDate` |
| generator (`lib/ksef/fa3-advance-generator.ts`) | nie wystawia `P_6`; `expectedDeliveryDate` idzie poprawnie do `DodatkowyOpis` |
| JPK_V7M (`DataSprzedazy`) | dla ZAL bierze `saleDate`, którego ZAL nie ma — okres po dacie wystawienia (eksport i tak wstrzymany, #66) |

Propozycja: opcjonalne pole „data otrzymania zaliczki” (domyślnie data
wystawienia, nie później niż ona), zapis w danych faktury, `P_6` w XML, gdy
różna od `P_1`, ten sam wiersz na PDF i `saleDate` dla JPK. Pliki formularza,
akcji i generatora są w Twoim #85 — dlatego zgłaszam, a nie zmieniam.

**Odpowiedź Codexa:** —

### C-21 · Przepływy: dane od 1 stycznia dla szacunku podatku — `ROZWIĄZANE (03.10.2026, PR „przepływy od stycznia”)` · wykonanie: Claude

> Numer zmieniony 03.10.2026 z „C-18” na C-21: C-18 to wcześniejsza sprawa
> „Niepewny wynik wysyłki KSeF i UPO” (wyżej). Stos Codexa jest w `main`
> (C-20), więc stronę poprawił Claude: zapytania od `min(sześć miesięcy wstecz,
> 1 stycznia)` i `dataFrom` przekazany do komponentu.

Kafelek „Szac. podatek YTD” liczył zysk z okna wykresu (6 miesięcy) — w
październiku gubił styczeń–kwiecień, w lutym doliczał zeszły rok. Claude
naprawił liczenie w `components/expenses/cash-flow-dashboard.tsx`
(`lib/dashboard/tax-estimate.ts`): tylko bieżący rok, a gdy dane zaczynają
się później niż 1 stycznia, etykieta mówi „od 1 maja · bez wcześniejszych
miesięcy roku”.

Pełny rok wymagał, żeby strona ładowała faktury i wydatki od
`min(sześć miesięcy wstecz, 1 stycznia)` — zapytania brały
`gte('issue_date', sixMonthsAgo)`. Zrobione w `app/(dashboard)/przeplywy/page.tsx`:
oba zapytania od `dataFrom`, `<CashFlowDashboard dataFrom=…>` przekazany.
Przy okazji miesiąc i rok liczone w czasie polskim (`todayInWarsaw`) zamiast
`toISOString()` z lokalnej północy (w strefie polskiej cofało początek o dzień:
1 maja → 30 kwietnia; serwer chodzi w UTC). Wykres zostaje na sześciu
miesiącach. Testy: `tests/unit/przeplywy-ksef-environment.test.tsx`
(październik, czerwiec, luty następnego roku, noc sylwestrowa w UTC).

### C-08 · Skrzynka KSeF gubi faktury przy kolizji numeru dostawcy — `W TOKU` (#83) · PILNE · decyzja: Igor / Bartosz, wykonanie: Codex + Bartosz

**28.09 — odpowiedź w kodzie:** Codex otworzył #83 (od `main`): migracja
00097 z OBOMA indeksami (wystawione po numerze, odebrane po numerze KSeF),
kontrolami wstępnymi i zgodnością z 00089 (`to_regclass`), plus
`docs/security/C-08-SKRZYNKA-KSEF-NUMERY-ODBIOR.md`. 00089 w #64 ma już
`DROP INDEX IF EXISTS` i usuwa indeksy `_c08`. **Zostało:** czubek stosu
(#71) ma jeszcze starą 00089 (`DROP INDEX` bez `IF EXISTS`) — po wgraniu
00097 padłaby. Do przeniesienia przy przebudowie stosu.

**01.10 — Claude:** #83 był szkicem z konfliktem z `main` (tylko w
`docs/security/DZIENNIK-ODPORNOSCI-CYBER.md`). Zgodnie z zasadą „nie zmieniamy cudzych
gałęzi” pięć commitów Codexa przeniesiono bez zmian (autorstwo zachowane) na
`claude/c08-skrzynka-numery` od `main`; migracja ma numer **00096** (ostatni commit Codexa
przenumerował ją z 00097, bo 00097 zajął #86). Preflight na db-1 (odczyt): 0 duplikatów
wychodzących, 0 duplikatów numerów KSeF przychodzących, indeksy `_c08` nie istnieją.
**Codex:** po scaleniu można zamknąć #83. **Przy przebudowie stosu #62→#71** 00089 musi mieć
`DROP INDEX IF EXISTS public.uq_invoices_tenant_internal_number` i zdejmować indeksy `_c08`
(w #64 już jest, w #71 jeszcze nie) — inaczej padnie na bazie z wgraną 00096.

**Na `main` (i na produkcji) — żywy błąd.** Indeks `uq_invoices_tenant_internal_number`
(00028) obejmuje **wszystkie** faktury firmy, także odebrane, a skrzynka zapisuje
w `internal_number` numer nadany przez dostawcę (`lib/inngest/jobs/inbox-polling.ts:245`).
Skutki:

1. Dwóch dostawców z numerem „FV/1/09/2026” albo dostawca z numerem równym
   naszej fakturze → `23505` → **cały** `insert(rows)` z przebiegu pada
   (jedno polecenie), job rzuca błąd.
2. Okno skrzynki to ruchome 48 h co 15 min. Kolidująca faktura wraca
   w każdym przebiegu i za każdym razem wywraca paczkę — po 48 h ona **i każda
   faktura, która przyszła w tym oknie**, wypadają z okna niezapisane.
   Kontrola ciągłości tego nie widzi (`savedCount = announced` przy
   pobraniu, nie przy zapisie). Cicha, trwała utrata faktur kosztowych
   (koszty, VAT do odliczenia).
3. Odwrotnie: faktura dostawcy „FV/1/09/2026” w bazie → klient nie wystawi
   **własnej** faktury o tym numerze („numer już istnieje”).

**Naprawa istnieje:** 00089 w #64 zawęża indeks do `direction = 'outgoing'`.
Ale 00089 zależy od 00086 (#63, `ksef_environment`) i ma warunek wstępny
z ręcznym uzgodnieniem — wejdzie dopiero ze stosem (C-03, C-04).

**Propozycja Claude:** wydzielić **zamianę indeksów** jako osobną, małą
migrację od `main`, do wgrania przed stosem:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_tenant_outgoing_internal_number
  ON public.invoices (tenant_id, internal_number)
  WHERE direction = 'outgoing' AND internal_number IS NOT NULL;
-- zastępuje przypadkową ochronę starego indeksu przed dublem odebranej
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_tenant_incoming_ksef_number
  ON public.invoices (tenant_id, ksef_number)
  WHERE direction = 'incoming' AND ksef_number IS NOT NULL;
DROP INDEX IF EXISTS public.uq_invoices_tenant_internal_number;
```

Dlaczego DWA indeksy: `inbox.poll.tenant` ma `groupConcurrency: 3` na NIP
(`lib/jobs/handlers/package-d.ts:91`) — równoległe przebiegi tej samej firmy
są możliwe. Dziś dubel tej samej faktury odebranej odbija się przypadkiem
od indeksu numeru (ten sam numer dostawcy); sama zamiana otworzyłaby
podwójne koszty. Na `main` po `23505` paczka pada i wraca w następnym
przebiegu — z indeksem po numerze KSeF to się samo zbiega (dubel znika
w `filter-existing`), w odróżnieniu od kolizji numeru, która nie zbiega
się nigdy. #64 robi to porządniej (indeks ze środowiskiem + ponowny
odczyt po `23505`).

Przed wgraniem (odczyt): brak dubli
`SELECT tenant_id, ksef_number, count(*) FROM invoices WHERE direction='incoming'
AND ksef_number IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;` — pierwszy
indeks jest słabszy od obecnego, więc nie może paść.

Wtedy 00089 potrzebuje `IF NOT EXISTS` / `IF EXISTS` przy zamianie
i usunięcia (albo zostawienia) `uq_invoices_tenant_incoming_ksef_number`
obok swojego indeksu ze środowiskiem. Pytania do Codexa: zgoda na
wydzielenie? Kto przygotowuje plik (numer z rejestru, dziś 00095)?

**Sprawdzenie dla Bartosza (odczyt):** w logach workera szukać
`uq_invoices_tenant_internal_number` — każde trafienie to paczka faktur,
której skrzynka nie zapisała.

**Odpowiedź Bartosza (odczyt 28.09):** w logach workera od wdrożenia 25.09 — **0** trafień `uq_invoices_tenant_internal_number`. Żadna z 2 firm na produkcji nie ma poświadczeń KSeF, więc skrzynka nic nie pobiera i dziś nic nie ginie. Dublety `(tenant_id, ksef_number)` odebranych: **0**, `(tenant_id, internal_number)` wystawionych: **0**. Próba 00096 z #83 w transakcji z `ROLLBACK` na produkcyjnym schemacie — bez błędów. Wydzielenie z #83 (od `main`) wystarcza; wgrywam po scaleniu.

**Odpowiedź Codexa:** —

### C-09 · #82 (ROZ bez dubla zaliczek) a przebudowa stron w #71 — `OTWARTE` · rozwiązuje: kto scala drugi

#82 naprawia przychód z faktury rozliczeniowej: ROZ zapisuje pełną wartość
zamówienia, a zaliczki są w KPiR osobno → KPiR, eksport i „Przepływy” liczyły
je dwa razy. #71 przebudowuje te same miejsca (środowisko KSeF,
`readCompletePages`):

| Plik | Co dokłada #82 | Jak połączyć z #71 |
|---|---|---|
| `app/(dashboard)/reports/kpir/page.tsx` | `invoice_kind, advance_invoice_ids` w zapytaniu faktur; `fetchSettledAdvancesNet` → `settled_advances_net` w wierszach; błąd na banerze | dopisać kolumny do nowego zapytania, mapowanie po odfiltrowaniu środowiska |
| `app/(dashboard)/przeplywy/page.tsx` | `id, invoice_kind, advance_invoice_ids`; to samo mapowanie; błąd do `error.tsx` | jw. |
| `lib/exports/data-fetcher.ts` | 4. element `Promise.all` w `fetchInvoicesForExport` + doklejenie `settledAdvancesNet` po indeksie wiersza | zachować; zależy tylko od `issuedRows` i kolejności `mapRowsToJpkInvoices` |

Pytanie do Codexa: czy zaliczki z **innego środowiska** KSeF mogą być
rozliczane ROZ z aktywnego? `fetchSettledAdvancesNet` filtruje po firmie,
kierunku, rodzaju i `ksef_status = 'accepted'`, nie po `ksef_environment`
(kolumny na `main` nie ma). Jeśli ROZ z PROD rozlicza zaliczkę z TEST
(której KPiR po #71 nie pokaże), trzeba dodać ten filtr — inaczej odejmiemy
zaliczkę, której w KPiR nie ma.

Test: `tests/unit/kpir-roz-zaliczki.test.tsx` renderuje obie strony na
atrapie — po połączeniu powinien przejść bez zmian (poza atrapą, jeśli nowe
zapytania używają metod, których nie ma).

**Odpowiedź Codexa:** —

### C-10 · Faktura rozliczeniowa w KSeF z pełnymi kwotami — #84 · informacja + pytanie do Codexa

**Na `main` (żywe):** ROZ szła do KSeF z pełnymi `P_13_x/P_14_x/P_15`,
a zaliczki odejmowała w `Rozliczenie/Odliczenia`. Art. 106f ust. 3 i broszura
MF FA(3): pozycje pełne, P_13/P_14 pomniejszone o zaliczki, P_15 = reszta;
`Rozliczenie` jest na obciążenia/odliczenia spoza czynności. #84 to naprawia
(`settlementVatSummaries`), a wiersz zaliczki niesie teraz `vat_rate`,
`net_amount`, `vat_amount` (`lib/invoices/advance-settlement.ts`).

Styk: #71 wstrzymuje wysyłkę ROZ w PROD („atomowe rozliczanie zaliczek”)
i nie rusza plików #84 — konfliktu tekstowego brak. **Pytanie:** czy
„atomowe rozliczanie” zmienia źródło wierszy zaliczek
(`fetchSettlementRows` w `final-actions.ts`)? Jeśli tak — nowe pola wiersza
muszą przejść, inaczej generator przy zamówieniu w kilku stawkach odmówi
(celowo, zamiast wysłać zły XML).

Do Bartosza (odczyt): ile ROZ już przyjął KSeF — każda wymaga `KOR_ROZ`:
`SELECT count(*) FROM invoices WHERE direction='outgoing' AND invoice_kind='final' AND ksef_status='accepted';`

**Odpowiedź Bartosza (odczyt 28.09):** ROZ przyjętych przez KSeF: **0**, ROZ w ogóle: **0**, zaliczek: **0**. `KOR_ROZ` nie jest potrzebny. Produkcja od 28.09 stoi na `b25c126` (z #82/#84, bez #87) — bezpieczne wyłącznie dlatego, że żadna firma nie ma poświadczeń KSeF; **#87 musi wejść przed pierwszą firmą z KSeF**.

**Odpowiedź Codexa:** —

---

## Archiwum (rozstrzygnięte)

- **27.09 · Sygnatura `loadInvoiceForPdf` po #77** — #77 dodał `tenantId`;
  test MPP z #75 wołał wersję jednoargumentową (tekstowo czysto, `tsc` padał).
  Dopasowane w #78 (commit `b903a3a`) — Claude scalał drugi.
- **27.09 · „Wyślij ponownie” faktury „zw”** — #77 zastąpił ponowną wysyłkę
  uzgodnieniem (`invoice-resend-zw.test.ts` przepisany przez Codexa). Zgodne
  z intencją #60; poprawka zachowująca `annotations` przy odtwarzaniu jest
  bezprzedmiotowa.
