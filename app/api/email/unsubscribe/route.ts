/**
 * One-click unsubscribe endpoint (Faza 26, RFC 8058).
 *
 * Obsługuje TRZY wywołania:
 *   1. **GET** `/api/email/unsubscribe?t=<token>` — user klika link w mailu.
 *      Zwraca HTML z pytaniem i przyciskiem — BEZ zapisu. Skanery poczty
 *      i podglądy linków otwierają linki same; do 02.10 GET wypisywał
 *      i wypisywał ludzi bez ich wiedzy (AUD-97).
 *   2. **POST** z formularza tej strony (`confirm=1`) — wypis, HTML z potwierdzeniem.
 *   3. **POST** z body `List-Unsubscribe=One-Click` — Gmail/Outlook one-click
 *      button. RFC 8058 wymaga POST z tym body. Zwraca JSON.
 *
 * Token jest HMAC-signed (bezstanowy) — nie wymaga DB lookup żeby zweryfikować
 * autentyczność. Sam unsubscribe to upsert do `email_preferences`.
 *
 * Idempotent: powtórny click na ten sam token = no-op (preferences UPSERT).
 */

import { NextResponse } from 'next/server';

import { unsubscribe } from '@/lib/email/preferences';
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe-token';
import { SUPPORT_EMAIL } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function htmlResponse(opts: {
  title: string;
  body: string;
  ok: boolean;
}): Response {
  const accentColor = opts.ok ? '#10b981' : '#dc2626';
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <title>FaktWay — ${opts.title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f6f6f6; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 12px; max-width: 480px; padding: 40px; margin: 20px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    h1 { color: ${accentColor}; margin: 0 0 16px; font-size: 24px; }
    p { color: #374151; line-height: 1.6; margin: 0 0 12px; }
    a { color: #111827; text-decoration: underline; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${opts.title}</h1>
    ${opts.body}
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Strona z pytaniem: formularz POST na ten sam adres. Token tylko w adresie
 * (base64url + kropka), więc w atrybucie jest bezpieczny po zakodowaniu.
 */
function confirmPage(token: string, categoryLabel: string): Response {
  const action = `/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
  return htmlResponse({
    title: 'Wypisać się?',
    body: `
      <p>Przestaniemy wysyłać Ci emaile z kategorii: <strong>${categoryLabel}</strong>.</p>
      <form method="post" action="${action}">
        <input type="hidden" name="confirm" value="1" />
        <button type="submit" style="margin-top:8px;padding:10px 20px;border:0;border-radius:8px;background:#111827;color:#fff;font-size:15px;cursor:pointer">Wypisz mnie</button>
      </form>
    `,
    ok: true,
  });
}

function categoryLabelOf(category: string): string {
  return category === 'transactional'
    ? 'transakcyjnych (faktury, KSeF, hasła)'
    : category === 'product_updates'
      ? 'powiadomień produktowych (welcome, paczki dla księgowej)'
      : 'powiadomień marketingowych';
}

async function handleUnsubscribe(
  token: string | null,
  source: 'one_click' | 'settings_ui',
  isOneClick: boolean,
  /** GET: tylko pytanie, bez zapisu. */
  confirmOnly = false,
): Promise<Response> {
  // Każde wejście przechodzi przez weryfikację. Brak tokenu jest również
  // wynikiem odmowy; osobna gałąź poniżej ustala tylko treść odpowiedzi.
  const verified = verifyUnsubscribeToken(token ?? '');
  if (!token) {
    if (isOneClick) {
      return NextResponse.json({ error: 'missing token' }, { status: 400 });
    }
    return htmlResponse({
      title: 'Nieprawidłowy link',
      body: '<p>Link wypisania jest niekompletny. Wyłącz powiadomienia w ustawieniach konta lub odpowiedz na ten email.</p>',
      ok: false,
    });
  }


  if (!verified.valid) {
    if (isOneClick) {
      // RFC 8058: zwracamy 200 OK nawet przy złym tokenie, żeby Gmail
      // nie spamował retry'ami. Ale logujemy do Sentry.
      return NextResponse.json({ skipped: true, reason: verified.reason });
    }
    const msg =
      verified.reason === 'expired'
        ? 'Link wypisania wygasł. Wyłącz powiadomienia w ustawieniach konta (Settings → Notifications).'
        : 'Link jest nieprawidłowy lub został zmodyfikowany.';
    return htmlResponse({
      title: 'Link nieprawidłowy',
      body: `<p>${msg}</p>`,
      ok: false,
    });
  }

  if (confirmOnly) return confirmPage(token, categoryLabelOf(verified.category));

  try {
    await unsubscribe({
      userId: verified.userId,
      category: verified.category,
      source,
    });
  } catch {
    if (isOneClick) {
      return NextResponse.json({ error: 'internal' }, { status: 500 });
    }
    return htmlResponse({
      title: 'Błąd',
      body: `<p>Wystąpił błąd. Spróbuj ponownie za chwilę albo skontaktuj się: ${SUPPORT_EMAIL}</p>`,
      ok: false,
    });
  }

  if (isOneClick) {
    return NextResponse.json({ unsubscribed: true });
  }

  const categoryLabel = categoryLabelOf(verified.category);

  return htmlResponse({
    title: 'Wypisano z subskrypcji',
    body: `
      <p>Nie będziemy więcej wysyłać Ci emaili z kategorii: <strong>${categoryLabel}</strong>.</p>
      <p>Możesz w każdej chwili wrócić — w <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ''}/settings/notifications">ustawieniach powiadomień</a>.</p>
      ${verified.category === 'transactional' ? '<p><em>Uwaga: emaile krytyczne (np. potwierdzenie faktury KSeF) i tak będą wysyłane — wymaga tego prawo i Twoje bezpieczeństwo. Sprawdź folder spam jeśli ich nie widzisz.</em></p>' : ''}
    `,
    ok: true,
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  return handleUnsubscribe(token, 'settings_ui', false, true);
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  // Formularz z naszej strony niesie `confirm=1` — odpowiadamy stroną HTML.
  const body = await req.text().catch(() => '');
  if (new URLSearchParams(body).get('confirm') === '1') {
    return handleUnsubscribe(token, 'settings_ui', false);
  }
  // RFC 8058: Gmail/Outlook one-click — POST z body `List-Unsubscribe=One-Click`.
  // Nie wymagamy ścisłej walidacji body (różne klienty mailowe wysyłają różne
  // formaty), wystarczy że POST przyszedł z poprawnym tokenem.
  return handleUnsubscribe(token, 'one_click', true);
}
