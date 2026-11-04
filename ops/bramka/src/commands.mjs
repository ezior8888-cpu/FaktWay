// Zamknięta lista poleceń bramki (06_PLAN_B § 5, krok 9 planu automatyzacji).
//
// Zasady:
//   - tylko czat prywatny i tylko osoby z BRAMKA_USERS (from.id); reszta jest
//     ignorowana bez odpowiedzi (identyfikator trafia wyłącznie do logu),
//   - odpowiedzi zawierają liczby i skróty, nigdy treści faktur ani danych
//     kontrahentów (regulamin botów Telegrama),
//   - /wylacz tylko WYŁĄCZA (A2): od razu, z powiadomieniem pozostałych osób;
//     włączenie z powrotem — ręcznie SQL-em (docs/runbooks/hamulce-ksef.md),
//   - /wdroz wymaga SHA i kodu TOTP (A1).
import { escapeHtml } from './clients.mjs';

export const DISABLE_TARGETS = {
  ksef: { flag: 'killAllKsefSubmissions', label: 'wysyłki faktur do KSeF' },
  flo: { flag: 'killFloAgent', label: 'agenta FLO' },
  rejestracja: { flag: 'disableSignups', label: 'rejestrację nowych kont' },
};

const HELP = [
  '<b>Bramka FaktWay</b>',
  '/status — zdrowie usług, KSeF, kopie, flagi',
  '/kolejki — zaległości zadań i faktury utknięte w wysyłce',
  '/wylacz ksef | flo | rejestracja — natychmiast wyłącza (bez TOTP)',
  '/wdroz — pokazuje, co zostanie wdrożone',
  '/wdroz &lt;8 znaków SHA&gt; &lt;kod TOTP&gt; — wdraża web i worker',
].join('\n');

/** „/wdroz@FaktWayBot abc” → { cmd: 'wdroz', args: ['abc'] } */
export function parseCommand(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  const m = /^\/([a-z]+)(?:@\w+)?$/i.exec(parts[0] ?? '');
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: parts.slice(1) };
}

function ago(iso, nowMs) {
  if (!iso) return 'brak';
  const min = Math.round((nowMs - Date.parse(iso)) / 60_000);
  if (min < 1) return 'przed chwilą';
  if (min < 120) return `${min} min temu`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h temu` : `${Math.round(h / 24)} dni temu`;
}

const pairs = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${escapeHtml(k)}: ${v}`).join(', ') || '—';

export function formatStatus(s, apps, nowMs) {
  const flags = s?.flags ?? {};
  const on = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
  const ksef = s?.ksef ? `${s.ksef.level} (${ago(s.ksef.at, nowMs)}, ${s.ksef.ms ?? '?'} ms)` : 'brak pomiarów';
  const backupAgeH = s?.backup?.at ? (nowMs - Date.parse(s.backup.at)) / 3_600_000 : null;
  const backup = s?.backup?.at
    ? `${ago(s.backup.at, nowMs)}${backupAgeH > 26 ? ' ⚠️ nieaktualna' : ''}`
    : 'brak ⚠️';
  return [
    '<b>Status FaktWay</b>',
    `Web: ${escapeHtml(apps.web)} · Worker: ${escapeHtml(apps.worker)}`,
    `Heartbeat workera: ${ago(s?.heartbeat_at, nowMs)}`,
    `KSeF: ${escapeHtml(ksef)}`,
    `Kopia bazy (JSON): ${backup}${s?.backup_failed_24h ? ` · porażki 24 h: ${s.backup_failed_24h}` : ''}`,
    `Wyłączniki aktywne: ${on.length ? on.map(escapeHtml).join(', ') + ' 🛑' : 'żaden'}`,
    `Ostatnia migracja: ${escapeHtml(s?.migration ?? '?')}`,
  ].join('\n');
}

export function formatQueues(queues, s, nowMs) {
  const inv = s?.invoices ?? {};
  const lines = ['<b>Kolejki</b>'];
  if (!queues?.length) {
    lines.push('Zadania pg-boss: brak zaległości.');
  } else {
    for (const q of queues.slice(0, 20)) {
      const parts = [];
      if (q.waiting) parts.push(`czeka ${q.waiting}${q.oldest_due ? ` (najstarsze ${ago(q.oldest_due, nowMs)})` : ''}`);
      if (q.active) parts.push(`w toku ${q.active}`);
      if (q.failed_24h) parts.push(`błędy 24 h ${q.failed_24h}`);
      lines.push(`• <code>${escapeHtml(q.name)}</code>: ${parts.join(', ')}`);
    }
    if (queues.length > 20) lines.push(`… i ${queues.length - 20} kolejnych`);
  }
  lines.push(
    `Faktury: wysyłane &gt; 15 min: ${inv.sending_15m ?? 0}, w kolejce &gt; 15 min: ${inv.queued_15m ?? 0}`,
    `Wstrzymane do uzgodnienia: ${pairs(inv.held)}`,
    `Offline24: ${pairs(s?.offline_queue)}`,
  );
  return lines.join('\n');
}

export function formatPlan(p) {
  if (!p.head) return `❌ ${escapeHtml(p.blockers[0])}`;
  const sha8 = p.head.slice(0, 8);
  const lines = [
    `<b>Do wdrożenia: <code>${sha8}</code></b>`,
    `Teraz: web ${p.webCommit?.slice(0, 8) ?? '?'} · worker ${p.workerCommit?.slice(0, 8) ?? '?'}`,
    `CI: ${p.ci.passed}/${p.ci.total} zielonych`,
  ];
  if (p.commits?.length) {
    lines.push(`Zmiany (${p.commits.length}):`, ...p.commits.slice(-8).map((c) => `• ${escapeHtml(c.slice(0, 90))}`));
  }
  if (p.blockers.length) {
    lines.push('', '<b>Nie można wdrożyć:</b>', ...p.blockers.map((b) => `• ${escapeHtml(b)}`));
  } else {
    lines.push('', `Aby wdrożyć web i worker: <code>/wdroz ${sha8} KOD</code> (kod z aplikacji TOTP).`);
  }
  return lines.join('\n');
}

/**
 * deps: { users: Map<id,name>, telegram, db, coolify, deployer, verifyTotp, config, now, log }
 */
export function createBramka(deps) {
  const { users, telegram, db, coolify, deployer, verifyTotp, config } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((...a) => console.log(...a));

  async function reply(chatId, html) {
    await telegram.sendMessage(chatId, html);
  }

  async function notifyOthers(exceptId, html) {
    for (const id of users.keys()) {
      if (id !== exceptId) await telegram.sendMessage(id, html).catch(() => {});
    }
  }

  async function appStatuses() {
    const [web, worker] = await Promise.all([
      coolify.appStatus(config.coolify.webUuid).catch(() => 'nieznany'),
      coolify.appStatus(config.coolify.workerUuid).catch(() => 'nieznany'),
    ]);
    return { web, worker };
  }

  async function handleUpdate(update) {
    const msg = update?.message;
    if (!msg?.text || msg.chat?.type !== 'private') return;
    const fromId = String(msg.from?.id ?? '');
    if (!users.has(fromId)) {
      log(`odrzucono wiadomość od from.id=${fromId} (spoza BRAMKA_USERS)`);
      return;
    }
    const name = users.get(fromId);
    const actor = `tg:${fromId}`;
    const chatId = msg.chat.id;
    const parsed = parseCommand(msg.text);
    if (!parsed) return reply(chatId, HELP);

    try {
      switch (parsed.cmd) {
        case 'start':
        case 'pomoc':
        case 'help':
          return await reply(chatId, HELP);

        case 'status': {
          const [s, apps] = await Promise.all([db.status(), appStatuses()]);
          return await reply(chatId, formatStatus(s, apps, now()));
        }

        case 'kolejki': {
          const [q, s] = await Promise.all([db.queues(), db.status()]);
          return await reply(chatId, formatQueues(q, s, now()));
        }

        case 'wylacz': {
          const target = DISABLE_TARGETS[(parsed.args[0] ?? '').toLowerCase()];
          if (!target) return await reply(chatId, 'Użycie: /wylacz ksef | flo | rejestracja');
          const r = await db.disable(target.flag, actor, `Telegram: ${name}`);
          const text = r.previous
            ? `ℹ️ ${escapeHtml(target.label)} były już wyłączone.`
            : `🛑 Wyłączono ${escapeHtml(target.label)}.`;
          await reply(chatId, `${text}\nWłączenie z powrotem: SQL według docs/runbooks/hamulce-ksef.md.`);
          if (!r.previous) await notifyOthers(fromId, `🛑 ${escapeHtml(name)} wyłączył(a) ${escapeHtml(target.label)} przez bramkę.`);
          return undefined;
        }

        case 'wdroz': {
          if (parsed.args.length === 0) {
            if (deployer.isRunning()) return await reply(chatId, '⏳ Wdrożenie już trwa.');
            const p = await deployer.plan();
            return await reply(chatId, formatPlan(p));
          }
          const [sha8, code] = parsed.args;
          if (!/^[0-9a-f]{8}$/i.test(sha8 ?? '') || !code) {
            return await reply(chatId, 'Użycie: /wdroz &lt;8 znaków SHA&gt; &lt;kod TOTP&gt; — najpierw /wdroz bez argumentów.');
          }
          const totp = verifyTotp(code);
          if (!totp.ok) {
            await db.log('ops.deploy.totp_rejected', actor, { reason: totp.reason }).catch(() => {});
            return await reply(chatId, totp.reason === 'locked'
              ? `🔒 Za dużo błędnych kodów. Spróbuj za ${Math.ceil(totp.retryAfterMs / 60_000)} min.`
              : '❌ Niepoprawny kod TOTP.');
          }
          const r = await deployer.start(sha8.toLowerCase(), actor, (html) => reply(chatId, html));
          if (!r.started) return await reply(chatId, `❌ Nie wdrażam:\n${escapeHtml(r.reason)}`);
          await reply(chatId, `🚀 Wdrażam <code>${r.head.slice(0, 8)}</code>: najpierw web, potem worker. Dam znać po każdym kroku.`);
          await notifyOthers(fromId, `🚀 ${escapeHtml(name)} uruchomił(a) wdrożenie <code>${r.head.slice(0, 8)}</code>.`);
          return undefined;
        }

        default:
          return await reply(chatId, `Nie znam polecenia /${escapeHtml(parsed.cmd)}.\n\n${HELP}`);
      }
    } catch (err) {
      log(`błąd polecenia /${parsed.cmd}: ${err instanceof Error ? err.message : 'nieznany'}`);
      return reply(chatId, `❌ Polecenie /${escapeHtml(parsed.cmd)} nie powiodło się. Szczegóły w logach bramki.`);
    }
  }

  return { handleUpdate };
}
