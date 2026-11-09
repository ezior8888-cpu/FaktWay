import {
  formatUploadSize,
  UPLOAD_FILE_LIMIT_LABEL,
  UPLOAD_IMAGE_LIMIT_LABEL,
} from '@/lib/upload-limit';

/**
 * Komunikat na Kosztach po odmowie `/share-target` (plan skalowania, sesja 31).
 * Udostępnienie z telefonu to nawigacja, bez okna, które mogłoby pokazać toast,
 * a pasek Flo z `?paragon=` nie jest dziś nigdzie wyświetlany — dlatego trasa
 * przekierowuje na `/expenses?udostepnienie=…`. Tam jest „Dodaj wydatek”, który
 * zdjęcia zmniejsza sam.
 *
 * W adresie są tylko kod i liczby (rozmiar, sekundy), nigdy tekst: link
 * zbudowany przez kogoś innego nie podsunie klientowi własnego komunikatu.
 */

export const SHARE_TARGET_NOTICE_PARAM = 'udostepnienie';

export type ShareTargetNotice =
  | { kind: 'za-duze'; size?: number; document?: 'zdjecie' | 'pdf' }
  | { kind: 'limit'; retryAfter?: number }
  | { kind: 'zajete' };

export function shareTargetNoticeHref(notice: ShareTargetNotice): string {
  const params = new URLSearchParams({ [SHARE_TARGET_NOTICE_PARAM]: notice.kind });
  if (notice.kind === 'za-duze') {
    if (notice.document) params.set('rodzaj', notice.document);
    if (notice.size) params.set('rozmiar', String(notice.size));
  }
  if (notice.kind === 'limit' && notice.retryAfter) params.set('za', String(notice.retryAfter));
  return `/expenses?${params.toString()}`;
}

type SearchValue = string | string[] | undefined;

function single(value: SearchValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Dodatnia liczba całkowita z adresu albo `undefined` (śmieci, ujemne, ułamki, za duże). */
function positiveInt(value: SearchValue, max: number): number | undefined {
  const raw = single(value);
  if (!raw || !/^\d{1,12}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 && n <= max ? n : undefined;
}

export function parseShareTargetNotice(params: Record<string, SearchValue>): ShareTargetNotice | null {
  const kind = single(params[SHARE_TARGET_NOTICE_PARAM]);
  if (kind === 'za-duze') {
    const rodzaj = single(params.rodzaj);
    return {
      kind,
      size: positiveInt(params.rozmiar, 1_000_000_000_000),
      document: rodzaj === 'zdjecie' || rodzaj === 'pdf' ? rodzaj : undefined,
    };
  }
  if (kind === 'limit') return { kind, retryAfter: positiveInt(params.za, 86_400) };
  if (kind === 'zajete') return { kind };
  return null;
}

const ADD_HERE = 'przyciskiem „Dodaj wydatek” na tej stronie';

function tooLargeText(notice: { size?: number; document?: 'zdjecie' | 'pdf' }): { title: string; body: string } {
  const size = notice.size ? formatUploadSize(notice.size) : null;
  if (notice.document === 'pdf') {
    const first = size
      ? `Udostępniony PDF ma ${size}, a można wgrać najwyżej ${UPLOAD_FILE_LIMIT_LABEL}.`
      : `Udostępniony PDF przekracza ${UPLOAD_FILE_LIMIT_LABEL} — tyle można wgrać najwyżej.`;
    return {
      title: 'PDF jest za duży — nie zapisaliśmy go',
      body: `${first} Zapisz go w niższej rozdzielczości albo podziel na mniejsze pliki i dodaj ${ADD_HERE}.`,
    };
  }
  if (notice.document === 'zdjecie') {
    const first = size
      ? `Udostępnione zdjęcie ma ${size}, a do odczytu można wysłać najwyżej ${UPLOAD_IMAGE_LIMIT_LABEL}.`
      : `Udostępnione zdjęcie przekracza ${UPLOAD_IMAGE_LIMIT_LABEL} — tyle przyjmuje odczyt.`;
    return {
      title: 'Zdjęcie jest za duże — nie zapisaliśmy go',
      body: `${first} Dodaj je ${ADD_HERE} (tam zdjęcia zmniejszamy sami) albo zrób zdjęcie w niższej rozdzielczości.`,
    };
  }
  const first = size
    ? `Udostępniony plik ma ${size}, a można wysłać najwyżej ${UPLOAD_FILE_LIMIT_LABEL} (PDF) albo ${UPLOAD_IMAGE_LIMIT_LABEL} (zdjęcie).`
    : `Udostępniony plik przekracza limit: ${UPLOAD_FILE_LIMIT_LABEL} dla PDF, ${UPLOAD_IMAGE_LIMIT_LABEL} dla zdjęcia.`;
  return {
    title: 'Plik jest za duży — nie zapisaliśmy go',
    body: `${first} Zdjęcie dodaj ${ADD_HERE} (tam zmniejszamy je sami).`,
  };
}

export function shareTargetNoticeText(notice: ShareTargetNotice): { title: string; body: string } {
  switch (notice.kind) {
    case 'za-duze':
      return tooLargeText(notice);
    case 'limit': {
      const wait = notice.retryAfter ? `za ${Math.max(1, Math.ceil(notice.retryAfter / 60))} min` : 'za kilka minut';
      return {
        title: 'Za dużo plików w krótkim czasie',
        body: `Pliku nie zapisaliśmy: w ostatnich minutach wysłano już dużo plików. Spróbuj ponownie ${wait}.`,
      };
    }
    case 'zajete':
      return {
        title: 'Serwer przyjmuje teraz dużo plików',
        body: `Pliku nie zapisaliśmy. Udostępnij go ponownie za kilka sekund albo dodaj ${ADD_HERE}.`,
      };
  }
}
