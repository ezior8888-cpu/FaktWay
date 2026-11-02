/**
 * Wersje dokumentów i DOKŁADNE brzmienie oświadczeń, które klient zaznacza.
 *
 * Po co brzmienie w kodzie: administrator musi umieć WYKAZAĆ, że zgoda została
 * wyrażona i na co (art. 7 ust. 1 RODO). Zapis „zgoda: tak” bez treści, na
 * którą ją dano, tego nie wykazuje. Każdy zapis zgody niesie więc `textVersion`,
 * a tu leży tekst każdej wersji. Starych wersji NIE usuwamy — dopisujemy nowe.
 *
 * Zmiana treści regulaminu albo umowy powierzenia = nowa `CONTRACT_VERSION`.
 * Bramka (lib/legal/acceptance.ts) poprosi wtedy każdego o akceptację; zasady
 * zmiany wobec klientów opisuje regulamin (§ 15) — powiadomienie z wyprzedzeniem.
 */

/**
 * Regulamin + umowa powierzenia są akceptowane razem — jedna wersja.
 * 2026-10-20: zmiana nazwy na FaktWay (faktway.pl); 2026-10-21: nazwy
 * zakładek ustawień z planu Finora (§ 14 ust. 2: „Ustawienia → Abonament”).
 * Wcześniejsze wersje nigdy nie były pokazane klientom (pakiet prawny nie był
 * wdrożony), więc nie ma zapisów zgód, które by się do nich odwoływały —
 * zastąpione, nie dopisane.
 */
export const CONTRACT_VERSION = '2026-10-21';
export const PRIVACY_POLICY_VERSION = '2026-10-21';
// 2026-10-22: cookie `sidebar_state` (menu boczne panelu, plan Finora).
// 2026-10-25: Turnstile także przy potwierdzaniu hasła w ustawieniach.
export const COOKIE_POLICY_VERSION = '2026-10-25';

/**
 * Oświadczenie przy rejestracji / w bramce (obowiązkowe). Znaczniki linków
 * (`[…](…)`) są częścią brzmienia — formularz pokazuje je jako odnośniki
 * (components/legal/legal-document.tsx, `LegalInline`).
 */
export const TERMS_STATEMENT = {
  version: '2026-10-21',
  text:
    'Akceptuję [Regulamin](/legal/regulamin) FaktWay i [Umowę powierzenia przetwarzania danych osobowych](/legal/umowa-powierzenia) ' +
    'oraz potwierdzam, że zapoznałem(-am) się z [Polityką prywatności](/legal/polityka-prywatnosci).',
} as const;

/**
 * Zgoda na e-maile o produkcie i ofertach (dobrowolna, art. 398 ust. 1 Prawa
 * komunikacji elektronicznej + art. 6 ust. 1 lit. a RODO).
 */
export const MARKETING_STATEMENT = {
  version: '2026-10-21',
  text:
    'Chcę otrzymywać e-mailem od FaktWay porady dotyczące korzystania z serwisu, ' +
    'informacje o nowościach i oferty. Zgodę mogę wycofać w każdej chwili ' +
    '(link w każdej wiadomości albo Ustawienia → Powiadomienia).',
} as const;

/**
 * Żądanie rozpoczęcia świadczenia przed upływem terminu na odstąpienie
 * (art. 15 ust. 3 i art. 35 ustawy o prawach konsumenta). Dotyczy tylko
 * konsumenta i przedsiębiorcy na prawach konsumenta — dla pozostałych jest
 * bez znaczenia, więc zaznacza je każdy.
 */
export const CHECKOUT_STATEMENT = {
  version: '2026-10-21',
  text:
    'Zamawiam subskrypcję z obowiązkiem zapłaty po okresie próbnym i akceptuję [Regulamin](/legal/regulamin). ' +
    'Jeśli zawieram umowę jako konsument lub przedsiębiorca na prawach konsumenta: żądam ' +
    'rozpoczęcia świadczenia przed upływem 14 dni na odstąpienie od umowy i przyjmuję do ' +
    'wiadomości, że w razie odstąpienia zapłacę za usługę świadczoną do chwili odstąpienia ' +
    '(okres próbny jest bezpłatny).',
} as const;

/**
 * Zgoda na cykliczne płatności BLIK-iem, zaznaczana razem z `CHECKOUT_STATEMENT`,
 * gdy włączony jest `STRIPE_BLIK_RECURRING` (lib/billing/trial-payment.ts). Przy
 * hostowanym Checkout warunki mandatu pokazuje sprzedawca, PRZED kodem BLIK
 * (docs.stripe.com/payments/blik/recurring-payments). Wersję zapisuje audyt
 * `legal.checkout_statement_accepted`.
 */
export const BLIK_RECURRING_STATEMENT = {
  version: '2026-11-02',
  text:
    'Jeśli na stronie płatności wybiorę BLIK, zgadzam się na cykliczne płatności: FaktWay będzie co miesiąc ' +
    'pobierać opłatę za subskrypcję z mojego konta bankowego bez ponownego kodu BLIK i bez zatwierdzania ' +
    'każdej płatności w aplikacji banku. Zgodę wycofam, anulując subskrypcję albo zmieniając metodę płatności.',
} as const;
