// Cloudflare Email Worker dla faktway.pl — B-3 Recepcja w trybie „tylko powiadom”
// (krok 10 planu automatyzacji, 06_PLAN_B § 3, MAN-18/19).
//
// Zmiana marki FaktFlow → FaktWay: w okresie przejściowym worker obsługuje OBIE
// domeny (faktway.pl i faktflow.pl). Nie zakłada żadnej z nich: bierze adres
// odbiorcy z wiadomości (`message.to`), więc ten sam kod podpina się pod Email
// Routing każdej strefy, a powiadomienie pokazuje dokładnie ten adres, na który
// ktoś napisał.
//
// Każda wiadomość na adres w obsługiwanej domenie:
//   1. idzie dalej do skrzynek z FORWARD_TO (adresy zweryfikowane w Email Routing),
//   2. wysyła do Telegrama powiadomienie: adres docelowy, kategoria, pilność.
//
// Do czasu opinii prawnej treść zgłoszeń NIE wychodzi do żadnego API: kategorię
// i pilność liczymy tu, ze słów kluczowych tematu, a w powiadomieniu nie ma
// nadawcy, tematu ani treści — tylko liczby i etykiety.
//
// Wdrożenie i konfiguracja: docs/runbooks/skrzynka-pomoc.md.

const CATEGORIES = [
  { id: 'RODO', label: 'RODO / dane osobowe', urgent: true, note: 'termin ustawowy: 1 miesiąc',
    words: ['rodo', 'gdpr', 'dane osobowe', 'usunięcie danych', 'usuniecie danych', 'usuń moje', 'usun moje', 'sprzeciw', 'inspektor'] },
  { id: 'ZWROT', label: 'płatność / zwrot', urgent: true,
    words: ['zwrot', 'refund', 'reklamacj', 'obciąż', 'obciaz', 'płatnoś', 'platnos', 'faktura za abonament', 'anuluj subskrypcj'] },
  { id: 'KSEF', label: 'KSeF / faktury', urgent: true,
    words: ['ksef', 'upo', 'odrzucon', 'nie wysła', 'nie wysla', 'certyfikat', 'token', 'offline'] },
  { id: 'DOSTEP', label: 'logowanie / dostęp', urgent: true,
    words: ['nie mogę się zalogować', 'nie moge sie zalogowac', 'hasło', 'haslo', '2fa', 'totp', 'zablokowan', 'logowani'] },
  { id: 'BLAD', label: 'błąd w aplikacji', urgent: false,
    words: ['błąd', 'blad', 'nie działa', 'nie dziala', 'error', 'problem'] },
  { id: 'SPRZEDAZ', label: 'pytanie przed zakupem', urgent: false,
    words: ['cena', 'cennik', 'ile kosztuj', 'kosztuje', 'oferta', 'demo', 'rachunkow', 'współprac', 'wspolprac'] },
];

// Adresy, które nie są zgłoszeniami klientów — przekazujemy, ale bez powiadomienia.
const QUIET_RECIPIENTS = new Set(['dmarc']);
const QUIET_SENDERS = /^(mailer-daemon|postmaster|noreply|no-reply|dmarc)/i;

/** Kategoria i pilność z tematu (czysta funkcja, testowana bez Cloudflare). */
export function classify(subject) {
  const text = String(subject ?? '').toLowerCase();
  for (const c of CATEGORIES) {
    if (c.words.some((w) => text.includes(w))) return c;
  }
  return { id: 'INNE', label: 'inne', urgent: false };
}

export function parseList(raw) {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Treść powiadomienia — bez nadawcy, tematu i treści wiadomości. Adres docelowy
 * pokazujemy w całości (`pomoc@faktway.pl` albo `pomoc@faktflow.pl`): operator
 * ma widzieć, którą domeną klient się posłużył.
 */
export function formatNotice({ recipient, category }) {
  const address = String(recipient ?? '').trim() || '?';
  return [
    `${category.urgent ? '🔴' : '📩'} Nowa wiadomość na ${address}`,
    `Kategoria: ${category.label}${category.urgent ? ' · pilne' : ''}`,
    category.note ? `Uwaga: ${category.note}` : '',
    'Treść jest w skrzynce pomocy — tu jej celowo nie ma.',
  ].filter(Boolean).join('\n');
}

export function shouldNotify({ recipient, sender }) {
  const local = String(recipient ?? '').split('@')[0].toLowerCase();
  if (QUIET_RECIPIENTS.has(local)) return false;
  return !QUIET_SENDERS.test(String(sender ?? ''));
}

async function notifyTelegram(env, text, fetchImpl) {
  const chats = parseList(env.TELEGRAM_CHAT_IDS);
  if (!env.TELEGRAM_BOT_TOKEN || chats.length === 0) return;
  await Promise.all(chats.map((chatId) => fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => undefined)));
}

export async function handleEmail(message, env, ctx, fetchImpl = fetch) {
  const destinations = parseList(env.FORWARD_TO);
  if (destinations.length === 0) {
    // Bez celu nie gubimy poczty po cichu: nadawca dostaje informację zwrotną.
    message.setReject('Skrzynka chwilowo niedostępna — spróbuj później.');
    return;
  }
  for (const to of destinations) await message.forward(to);

  if (shouldNotify({ recipient: message.to, sender: message.from })) {
    const category = classify(message.headers.get('subject'));
    ctx.waitUntil(notifyTelegram(env, formatNotice({ recipient: message.to, category }), fetchImpl));
  }
}

const worker = {
  async email(message, env, ctx) {
    await handleEmail(message, env, ctx);
  },
};

export default worker;
