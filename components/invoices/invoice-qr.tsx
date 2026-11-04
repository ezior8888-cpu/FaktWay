'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Kod QR weryfikacji faktury w KSeF (KOD I) na podglądzie faktury (P4).
 *
 * Link i podpis liczy strona na serwerze z `lib/ksef/qr-verification.ts`
 * (NIP sprzedawcy, data wystawienia, SHA-256 pliku XML, środowisko) — ten
 * sam link co na PDF. Obraz powstaje w przeglądarce, żeby nie dokładać
 * obrazów do danych strony. Bez linku (`qr = null`: brak XML, import,
 * skrzynka) komponent nic nie pokazuje — lepiej bez kodu niż z kodem,
 * który prowadzi donikąd. Błąd generowania obrazu też zostawia sam dokument.
 */
export interface InvoiceQrData {
  url: string;
  /** Podpis pod kodem: numer KSeF. */
  label: string;
}

export function InvoiceQr({ qr }: { qr: InvoiceQrData | null }) {
  const url = qr?.url ?? null;
  const [image, setImage] = useState<{ url: string; src: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 160, errorCorrectionLevel: 'M' })
      .then((src) => {
        if (!cancelled) setImage({ url, src });
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!qr || image?.url !== qr.url) return null;

  return (
    <figure data-testid="kod-qr" className="flex w-40 flex-col items-center gap-1 print:w-32">
      {/* Obraz data: z biblioteki qrcode — next/image nic tu nie optymalizuje. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.src} alt="Kod QR do weryfikacji faktury w KSeF" width={160} height={160} className="size-40 print:size-32" />
      <figcaption className="text-muted-foreground w-full break-all text-center font-mono text-[10px] leading-tight">
        {qr.label}
      </figcaption>
    </figure>
  );
}
