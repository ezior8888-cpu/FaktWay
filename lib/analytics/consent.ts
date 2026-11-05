/** Browser analytics starts only after an explicit opt-in. */
export const CONSENT_KEY = 'ff_analytics_consent';
/** Kiedy padł wybór i czy dotarł już na konto (synchronizacja: consent-sync.ts). */
export const CONSENT_META_KEY = 'ff_analytics_consent_meta';
export const ANALYTICS_CONSENT_EVENT = 'ff:analytics-consent';

export type ConsentState = 'granted' | 'denied' | 'unset';

export interface ConsentRecord {
  consent: ConsentState;
  /** Chwila wyboru; `null` tylko przy odmowie sprzed zapisu daty (przed 11.2026). */
  chosenAt: string | null;
  /** Wybór dotarł na konto. Taki wybór nie przechodzi już na inne konto w tej przeglądarce. */
  synced: boolean;
}

const UNSET: ConsentRecord = { consent: 'unset', chosenAt: null, synced: false };

// A choice still applies to this page when storage is unavailable.
let transient: ConsentRecord | undefined;

export function isAnalyticsConfigured(): boolean {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!key) return false;
  if (key.startsWith('phc_xxx') || key === 'phc_placeholder') return false;
  return true;
}

function parseMeta(raw: string | null): Pick<ConsentRecord, 'chosenAt' | 'synced'> {
  try {
    const meta: unknown = raw ? JSON.parse(raw) : null;
    if (typeof meta === 'object' && meta !== null) {
      const { chosenAt, synced } = meta as { chosenAt?: unknown; synced?: unknown };
      const validDate = typeof chosenAt === 'string' && !Number.isNaN(Date.parse(chosenAt));
      return { chosenAt: validDate ? chosenAt : null, synced: synced === true };
    }
  } catch {
    // Uszkodzony zapis to brak daty: serwer przyjmie taki wybór tylko bez własnej decyzji.
  }
  return { chosenAt: null, synced: false };
}

export function readAnalyticsConsentRecord(): ConsentRecord {
  if (typeof window === 'undefined') return UNSET;
  if (transient !== undefined) return transient;
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    if (value !== 'granted' && value !== 'denied') return UNSET;
    const meta = parseMeta(window.localStorage.getItem(CONSENT_META_KEY));
    // Zgoda bez daty pochodzi sprzed 11.2026: stary baner mówił o samych statystykach,
    // a polityka, że nic nie zapisujemy. Na ciasteczko źródła i zapis na koncie tej zgody
    // nie było, więc baner pyta od nowa. Odmowa zostaje, bo nie potrzebuje nowego brzmienia.
    if (value === 'granted' && !meta.chosenAt) return UNSET;
    return { consent: value, ...meta };
  } catch {
    return UNSET;
  }
}

export function getAnalyticsConsent(): ConsentState {
  return readAnalyticsConsentRecord().consent;
}

function writeRecord(record: ConsentRecord, notify: boolean): void {
  transient = record;
  try {
    if (record.consent === 'unset') {
      window.localStorage.removeItem(CONSENT_KEY);
      window.localStorage.removeItem(CONSENT_META_KEY);
    } else {
      // Data przed decyzją: inna karta po zdarzeniu `storage` nie może zobaczyć zgody bez daty.
      window.localStorage.setItem(
        CONSENT_META_KEY,
        JSON.stringify({ chosenAt: record.chosenAt, synced: record.synced }),
      );
      window.localStorage.setItem(CONSENT_KEY, record.consent);
    }
    transient = undefined;
  } catch {
    // The current choice stays in memory until this page is closed.
  }
  if (notify) window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}

/** Wybór człowieka w tej przeglądarce: obowiązuje od razu, serwer dostaje go przez consent-sync.ts. */
export function setAnalyticsConsent(granted: boolean): void {
  if (typeof window === 'undefined') return;
  writeRecord({
    consent: granted ? 'granted' : 'denied',
    chosenAt: new Date().toISOString(),
    synced: false,
  }, true);
}

/** Decyzja z konta (ostatni wybór wygrał na serwerze). */
export function adoptAnalyticsConsent(consent: 'granted' | 'denied', chosenAt: string): void {
  if (typeof window === 'undefined') return;
  const before = readAnalyticsConsentRecord();
  // Zdarzenie także przy samym dostarczeniu: ciasteczko źródła przestaje wtedy cokolwiek dowodzić.
  writeRecord({ consent, chosenAt, synced: true }, before.consent !== consent || !before.synced);
}

/** Wybór z tej przeglądarki trafił na konto przy rejestracji (znacznik w ciasteczku źródła). */
export function markAnalyticsConsentDelivered(): void {
  if (typeof window === 'undefined') return;
  const record = readAnalyticsConsentRecord();
  if (record.consent === 'unset' || record.synced) return;
  writeRecord({ ...record, synced: true }, true);
}

/** Wybór należał do innego konta: ta przeglądarka wraca do „bez decyzji” i baner pyta od nowa. */
export function forgetAnalyticsConsent(): void {
  if (typeof window === 'undefined') return;
  writeRecord(UNSET, true);
}

export function hasAnalyticsConsent(): boolean {
  return getAnalyticsConsent() === 'granted';
}
