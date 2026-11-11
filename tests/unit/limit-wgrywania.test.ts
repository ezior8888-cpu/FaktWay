import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { PHOTO_KEEP_MAX_BYTES, shrunkSize } from '@/lib/expenses/photo-upload';
import {
  formatUploadSize,
  UPLOAD_BODY_LIMIT_BYTES,
  UPLOAD_FILE_LIMIT_BYTES,
  UPLOAD_FILE_LIMIT_LABEL,
  UPLOAD_IMAGE_LIMIT_BYTES,
  UPLOAD_IMAGE_LIMIT_LABEL,
} from '@/lib/upload-limit';

/**
 * Limity tras wgrywania (plan skalowania, sesje 4 i 31). Do sesji 31 plik
 * szedł Server Action (najwyżej 1 MiB ciała); teraz trasami `/api/uploads/*`
 * i `/share-target` z własnym limitem `Content-Length`.
 */

// Domyślna konfiguracja Next 16 — limit kopii ciała, którą proxy trzyma w pamięci.
const { defaultConfig } = createRequire(import.meta.url)('next/dist/server/config-shared.js') as {
  defaultConfig: { experimental: { proxyClientMaxBodySize: number } };
};

/** Ciało `multipart/form-data` dokładnie tak, jak koduje je przeglądarka (`fetch` z `FormData`). */
async function multipartBytes(fields: Record<string, string | File>): Promise<number> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return (await new Request('https://faktway.test/', { method: 'POST', body: form }).arrayBuffer()).byteLength;
}

// 255 znaków dwubajtowych — dłuższej nazwy system plików nie przepuści.
const LONGEST_NAME = `${'ż'.repeat(251)}.csv`;

describe('limit ciała tras wgrywania', () => {
  it('największy CSV importu z najdłuższą nazwą i polami obok mieści się w limicie ciała', async () => {
    const total = await multipartBytes({
      file: new File([new Uint8Array(UPLOAD_FILE_LIMIT_BYTES)], LONGEST_NAME, { type: 'text/csv' }),
      source: 'fakturownia_csv',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(total).toBeGreaterThan(UPLOAD_FILE_LIMIT_BYTES);
    expect(total).toBeLessThanOrEqual(UPLOAD_BODY_LIMIT_BYTES);
  });

  it('największy PDF kosztu z najdłuższą nazwą mieści się w limicie ciała', async () => {
    const total = await multipartBytes({
      photo: new File([new Uint8Array(UPLOAD_FILE_LIMIT_BYTES)], LONGEST_NAME.replace('.csv', '.pdf'), { type: 'application/pdf' }),
    });
    expect(total).toBeLessThanOrEqual(UPLOAD_BODY_LIMIT_BYTES);
  });

  it('limit ciała jest poniżej kopii, którą trzyma proxy Next (gdyby trasa wróciła pod proxy, nie dotrze ucięta)', () => {
    expect(defaultConfig.experimental.proxyClientMaxBodySize).toBe(10 * 1024 * 1024);
    expect(UPLOAD_BODY_LIMIT_BYTES).toBeLessThan(defaultConfig.experimental.proxyClientMaxBodySize);
  });

  it('wartości i podpisy: 10 MB pliku, 7 MB zdjęcia', () => {
    expect(UPLOAD_FILE_LIMIT_BYTES).toBe(10_000_000);
    expect(UPLOAD_FILE_LIMIT_LABEL).toBe('10 MB');
    expect(UPLOAD_IMAGE_LIMIT_BYTES).toBe(7_000_000);
    expect(UPLOAD_IMAGE_LIMIT_LABEL).toBe('7 MB');
  });

  it('zdjęcie na limicie mieści się w limicie odczytu (10 MB po zakodowaniu base64)', () => {
    const base64Length = Math.ceil(UPLOAD_IMAGE_LIMIT_BYTES / 3) * 4;
    expect(base64Length).toBeLessThan(10_000_000);
    // …a zdjęcie 7,5 MB już nie (stąd zapas).
    expect(Math.ceil(7_500_000 / 3) * 4).toBeGreaterThanOrEqual(10_000_000);
  });

  it('zmniejszanie zdjęć celuje w 1 MB, czyli poniżej limitu zdjęcia', () => {
    expect(PHOTO_KEEP_MAX_BYTES).toBe(1_000_000);
    expect(PHOTO_KEEP_MAX_BYTES).toBeLessThan(UPLOAD_IMAGE_LIMIT_BYTES);
  });
});

describe('rozmiar w komunikacie', () => {
  it('po polsku, zaokrąglony w górę', () => {
    expect(formatUploadSize(300 * 1024)).toBe('308 KB');
    expect(formatUploadSize(1_500_000)).toBe('1,5 MB');
    expect(formatUploadSize(2 * 1024 * 1024)).toBe('2,1 MB');
    expect(formatUploadSize(2_100_000)).toBe('2,1 MB');
  });

  it('plik tuż ponad limitem nie wygląda na mieszczący się', () => {
    // Recenzja sesji 4: przy limicie 1 MiB − 16 KiB komunikat brzmiał
    // „Plik ma 1016 KB / 1,0 MB, a można wgrać najwyżej 1 MB”.
    for (const bytes of [UPLOAD_FILE_LIMIT_BYTES + 1, 10_040_000, 10_099_999]) {
      expect(formatUploadSize(bytes)).toBe('10,1 MB');
    }
    expect(formatUploadSize(UPLOAD_IMAGE_LIMIT_BYTES + 1)).toBe('7,1 MB');
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
