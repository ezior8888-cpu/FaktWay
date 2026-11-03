import { createRequire } from 'node:module';

import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { describe, expect, it } from 'vitest';

import { shrunkSize } from '@/lib/expenses/photo-upload';
import {
  ACTION_BODY_LIMIT_BYTES,
  ACTION_FILE_LIMIT_BYTES,
  ACTION_FILE_LIMIT_LABEL,
  UPLOAD_APP_UPDATED_MESSAGE,
  UPLOAD_FAILED_MESSAGE,
  formatUploadSize,
  uploadRejectedMessage,
} from '@/lib/upload-limit';

// Ten sam koder argumentów, którym przeglądarka wysyła Server Action
// (`encodeReply` z Reacta wkompilowanego w Next). Next nie publikuje do niego
// typów, więc podpis jednej funkcji opisujemy sami.
const { encodeReply } = createRequire(import.meta.url)('next/dist/compiled/react-server-dom-webpack/client.node.js') as {
  encodeReply: (value: unknown, options: object) => Promise<FormData | string>;
};

/**
 * Sesja 4 planu skalowania: przeglądarka zatrzymuje plik większy niż
 * `ACTION_FILE_LIMIT_BYTES`. Ten limit musi zostawić zapas na resztę ciała
 * żądania (granice multipart, nagłówki pola z nazwą pliku, pole z argumentami),
 * bo Next liczy do 1 MiB całe ciało, nie sam plik.
 */

/** Domyślny limit ciała Server Action w Next 16 (`action-handler.js`). */
const NEXT_ACTION_BODY_LIMIT = 1024 * 1024;

async function bodyBytes(file: File): Promise<number> {
  const form = new FormData();
  form.append('photo', file);
  const body = await encodeReply([form], {});
  return (await new Response(body).arrayBuffer()).byteLength;
}

describe('limit pliku wysyłanego przez Server Action', () => {
  it('plik równy limitowi, z najdłuższą nazwą, mieści się w 1 MiB ciała żądania', async () => {
    // 255 znaków dwubajtowych — dłuższej nazwy system plików nie przepuści.
    const name = `${'ż'.repeat(251)}.pdf`;
    const file = new File([new Uint8Array(ACTION_FILE_LIMIT_BYTES)], name, { type: 'application/pdf' });

    const total = await bodyBytes(file);
    expect(total).toBeGreaterThan(ACTION_FILE_LIMIT_BYTES);
    expect(total).toBeLessThanOrEqual(NEXT_ACTION_BODY_LIMIT);
  });

  it('limit to 1 MB dziesiętnie, poniżej limitu ciała Next', () => {
    expect(ACTION_BODY_LIMIT_BYTES).toBe(NEXT_ACTION_BODY_LIMIT);
    expect(ACTION_FILE_LIMIT_BYTES).toBe(1_000_000);
    expect(ACTION_FILE_LIMIT_LABEL).toBe('1 MB');
  });

  it('rozmiar po polsku, zaokrąglony w górę', () => {
    expect(formatUploadSize(300 * 1024)).toBe('308 KB');
    expect(formatUploadSize(1_500_000)).toBe('1,5 MB');
    expect(formatUploadSize(2 * 1024 * 1024)).toBe('2,1 MB');
    expect(formatUploadSize(2_100_000)).toBe('2,1 MB');
  });

  it('plik tuż ponad limitem nie wygląda na mieszczący się', () => {
    // Recenzja: przy limicie 1 MiB − 16 KiB komunikat brzmiał
    // „Plik ma 1016 KB / 1,0 MB, a można wgrać najwyżej 1 MB”.
    for (const bytes of [ACTION_FILE_LIMIT_BYTES + 1, 1_040_000, 1_048_576, 1_099_999]) {
      expect(formatUploadSize(bytes)).toBe('1,1 MB');
    }
  });

  it('odrzucona obietnica: nieznana akcja (strona sprzed wdrożenia) ≠ błąd sieci', () => {
    expect(uploadRejectedMessage(new UnrecognizedActionError('x'))).toBe(UPLOAD_APP_UPDATED_MESSAGE);
    expect(uploadRejectedMessage(new Error('Body exceeded 1 MB limit.'))).toBe(UPLOAD_FAILED_MESSAGE);
    expect(uploadRejectedMessage(new TypeError('Failed to fetch'))).toBe(UPLOAD_FAILED_MESSAGE);
  });
});

describe('wymiary zmniejszonego zdjęcia', () => {
  it('dłuższy bok 2000 px, bez powiększania', () => {
    expect(shrunkSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(shrunkSize(3000, 4000)).toEqual({ width: 1500, height: 2000 });
    expect(shrunkSize(8160, 6120)).toEqual({ width: 2000, height: 1500 });
    expect(shrunkSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('obraz węższy niż 1:2 zachowuje krótszy bok ≥ 1000 px, dłuższy ≤ 4096 px', () => {
    expect(shrunkSize(1080, 10_000)).toEqual({ width: 442, height: 4096 });
    expect(shrunkSize(1080, 4000)).toEqual({ width: 1000, height: 3704 });
    expect(shrunkSize(4000, 1500)).toEqual({ width: 2667, height: 1000 });
    // 2:1 i szersze proporcje jak zwykłe zdjęcie.
    expect(shrunkSize(4000, 2000)).toEqual({ width: 2000, height: 1000 });
  });
});
