/** Browser analytics starts only after an explicit opt-in. */
export const CONSENT_KEY = 'ff_analytics_consent';
/** Kiedy padł wybór i czy dotarł już na konto (synchronizacja: consent-sync.ts). */
export const CONSENT_META_KEY = 'ff_analytics_consent_meta';
export const ANALYTICS_CONSENT_EVENT = 'ff:analytics-consent';

export type ConsentState = 'granted' | 'denied' | 'unset';

export interface ConsentRecord {
  consent: ConsentState;
  /** Chwila wyboru; `null` przy wyborze sprzed zapisu daty (przed 11.2026). */
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
    return { consent: value, ...parseMeta(window.localStorage.getItem(CONSENT_META_KEY)) };
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
      window.localStorage.setItem(CONSENT_KEY, record.consent);
      window.localStorage.setItem(
        CONSENT_META_KEY,
        JSON.stringify({ chosenAt: record.chosenAt, synced: record.synced }),
      );
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
  const changed = getAnalyticsConsent() !== consent;
  writeRecord({ consent, chosenAt, synced: true }, changed);
}

/** Wybór należał do innego konta: ta przeglądarka wraca do „bez decyzji” i baner pyta od nowa. */
export function forgetAnalyticsConsent(): void {
  if (typeof window === 'undefined') return;
  writeRecord(UNSET, true);
}

export function hasAnalyticsConsent(): boolean {
  return getAnalyticsConsent() === 'granted';
}
