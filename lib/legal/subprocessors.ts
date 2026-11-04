/**
 * Podmioty, którym FaktWay powierza dane — jedna lista dla polityki
 * prywatności, umowy powierzenia (załącznik) i strony /legal/podprocesorzy.
 *
 * Do 15.10.2026 polityka wymieniała Vercel, Supabase Cloud, Cloudflare R2,
 * AWS Glacier i Inngest — po przeprowadzce na Hetznera (14.09.2026) żadnego
 * z nich już nie ma, za to brakowało Slacka, do którego trafia adres e-mail
 * przy prośbie o kontakt z człowiekiem (lib/support/support-actions.ts).
 * Lista, która nie zgadza się z rzeczywistością, to naruszenie art. 13 RODO
 * i art. 28 ust. 2 RODO (zmiana podprocesora wymaga uprzedzenia klienta).
 *
 * ZASADA: nowa usługa zewnętrzna, która widzi dane osobowe → wpis tutaj
 * w tym samym PR + powiadomienie klientów (umowa powierzenia, § 6 ust. 3).
 * Nieaktywne dziś (nie wpisuj, dopóki nie ruszą na produkcji): AWS S3 Glacier
 * (archiwum, `AWS_*`).
 *
 * Redis NIE jest osobnym dostawcą: to własny redis:7.2 z nakładką
 * `hiett/serverless-redis-http` na serwerze app-1, więc mieści się we wpisie
 * Hetzner. Zmienne nazywają się UPSTASH_REDIS_REST_* tylko dlatego, że
 * nakładka udaje API Upstash — Upstash Inc. nie widzi danych (stan 23.10.2026).
 * Wpis potrzebny dopiero wtedy, gdy UPSTASH_REDIS_REST_URL wskaże usługę
 * zewnętrzną (np. *.upstash.io).
 */

export type ProcessingRole =
  /** Przetwarza dane, które FaktWay powierzył klient (faktury, kontrahenci) — podprocesor z umowy powierzenia. */
  | 'client_data'
  /** Przetwarza wyłącznie dane, których administratorem jest FaktWay (konta, rozliczenia, analityka). */
  | 'own_data';

export interface Subprocessor {
  name: string;
  /** Siedziba podmiotu (państwo). */
  seat: string;
  purpose: string;
  /** Gdzie fizycznie leżą dane. */
  location: string;
  /** Czy dane mogą opuścić EOG i na jakiej podstawie. */
  transfer: string;
  roles: ProcessingRole[];
}

const SCC_OR_DPF =
  'możliwy dostęp z USA — standardowe klauzule umowne Komisji Europejskiej (art. 46 ust. 2 lit. c RODO), a jeśli odbiorca jest certyfikowany — EU-US Data Privacy Framework (art. 45 RODO)';

export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Hetzner Online GmbH',
    seat: 'Niemcy',
    purpose:
      'serwery aplikacji, bazy danych, magazyn plików (XML, PDF, zdjęcia dokumentów) i kopie zapasowe',
    location: 'centrum danych w Norymberdze (Niemcy)',
    transfer: 'brak — dane pozostają w EOG',
    roles: ['client_data', 'own_data'],
  },
  {
    name: 'Anthropic',
    seat: 'USA',
    purpose:
      'funkcje AI: odczyt danych ze zdjęć i plików dokumentów kosztowych (OCR), propozycja kolumny KPiR, odpowiedzi asystenta w czacie pomocy',
    location: 'USA',
    transfer: SCC_OR_DPF,
    roles: ['client_data', 'own_data'],
  },
  {
    name: 'Resend, Inc.',
    seat: 'USA',
    purpose:
      'wysyłka wiadomości e-mail: powiadomienia, faktury i przypomnienia o płatności wysyłane na polecenie klienta do jego kontrahentów',
    location: 'USA lub UE (region wysyłki)',
    transfer: SCC_OR_DPF,
    roles: ['client_data', 'own_data'],
  },
  {
    name: 'Functional Software, Inc. (Sentry)',
    seat: 'USA',
    purpose:
      'monitorowanie błędów aplikacji; raporty są automatycznie oczyszczane z danych osobowych, ale mogą je zawierać przypadkowo',
    location: 'region danych UE (Niemcy)',
    transfer: SCC_OR_DPF,
    roles: ['client_data', 'own_data'],
  },
  {
    name: 'PostHog, Inc.',
    seat: 'USA',
    purpose:
      'analityka korzystania z serwisu wyłącznie po wyrażeniu zgody: zdarzenia z przeglądarki i z serwera, bez danych z dokumentów, z pseudonimowym identyfikatorem',
    location: 'region danych UE (Niemcy)',
    transfer: SCC_OR_DPF,
    roles: ['own_data'],
  },
  {
    name: 'Cloudflare, Inc.',
    seat: 'USA',
    // Poczta: Cloudflare Email Routing na faktway.pl i dawnej faktflow.pl
    // (lib/site.ts, docs/runbooks/skrzynka-pomoc.md) — przez Cloudflare
    // przechodzi każdy mail na pomoc@, także żądania RODO. Skrzynka docelowa
    // to osobny dostawca (lista kontrolna, docs/prawne/).
    purpose:
      'ochrona formularzy logowania i rejestracji przed botami (Turnstile); przekazywanie poczty przychodzącej na adresy @faktway.pl (i dawne @faktflow.pl)',
    location: 'globalna sieć Cloudflare',
    transfer: SCC_OR_DPF,
    roles: ['own_data'],
  },
  {
    name: 'Slack Technologies, LLC',
    seat: 'USA',
    purpose:
      'wewnętrzne alerty zespołu; przy prośbie o kontakt z człowiekiem w czacie pomocy alert zawiera adres e-mail użytkownika',
    location: 'USA',
    transfer: SCC_OR_DPF,
    roles: ['own_data'],
  },
  {
    name: 'Stripe Payments Europe, Ltd.',
    seat: 'Irlandia',
    purpose:
      'obsługa płatności za subskrypcję (dane karty trafiają bezpośrednio do Stripe; w zakresie zapobiegania oszustwom i obowiązków prawnych Stripe jest odrębnym administratorem)',
    location: 'UE i USA',
    transfer: SCC_OR_DPF,
    roles: ['own_data'],
  },
];

export function subprocessorsFor(role: ProcessingRole): Subprocessor[] {
  return SUBPROCESSORS.filter((s) => s.roles.includes(role));
}
