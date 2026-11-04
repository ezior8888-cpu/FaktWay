import assert from 'node:assert/strict';
import test from 'node:test';

import { createBramka, formatPlan, formatQueues, formatStatus, parseCommand } from '../src/commands.mjs';
import { parseUsers } from '../src/config.mjs';

const BARTOSZ = '111';
const IGOR = '222';
const OBCY = '999';
const NOW = Date.parse('2026-10-01T20:00:00Z');

function setup({ totpOk = true, plan, start } = {}) {
  const sent = [];
  const calls = { disable: [], log: [], start: [] };
  const deps = {
    users: parseUsers(`${BARTOSZ}:Bartosz,${IGOR}:Igor`),
    telegram: { sendMessage: async (chatId, html) => { sent.push({ chatId: String(chatId), html }); } },
    db: {
      status: async () => ({
        flags: { killAllKsefSubmissions: false, killFloAgent: true },
        ksef: { level: 'operational', at: '2026-10-01T19:58:00Z', ms: 100 },
        backup: { at: '2026-10-01T00:00:41Z' },
        backup_failed_24h: 0,
        heartbeat_at: '2026-10-01T19:59:00Z',
        migration: '00100',
        invoices: { sending_15m: 1, queued_15m: 0, held: { KSEF_PAUSED: 2 } },
        offline_queue: null,
      }),
      queues: async () => [{ name: 'invoice/submit.requested', waiting: 3, active: 1, failed_24h: 0, oldest_due: '2026-10-01T19:40:00Z' }],
      disable: async (flag, actor, note) => { calls.disable.push({ flag, actor, note }); return { flag, previous: false, enabled: true }; },
      log: async (action, actor, meta) => { calls.log.push({ action, actor, meta }); },
    },
    coolify: { appStatus: async () => 'running:healthy' },
    deployer: {
      isRunning: () => false,
      plan: plan ?? (async () => ({ head: 'abcdef1234567890', webCommit: '1111111122', workerCommit: '1111111122', ci: { passed: 10, total: 10 }, commits: ['feat: x'], blockers: [] })),
      start: start ?? (async (sha8, actor) => { calls.start.push({ sha8, actor }); return { started: true, head: 'abcdef1234567890' }; }),
    },
    verifyTotp: () => (totpOk ? { ok: true } : { ok: false, reason: 'mismatch' }),
    config: { coolify: { webUuid: 'w', workerUuid: 'k' } },
    now: () => NOW,
    log: () => {},
  };
  const bramka = createBramka(deps);
  const say = (fromId, text, chatType = 'private') => bramka.handleUpdate({
    update_id: 1, message: { text, chat: { id: Number(fromId), type: chatType }, from: { id: Number(fromId) } },
  });
  return { sent, calls, say };
}

test('parsowanie poleceń, także z nazwą bota', () => {
  assert.deepEqual(parseCommand('/wdroz@FaktWayBot abcdef12 123456'), { cmd: 'wdroz', args: ['abcdef12', '123456'] });
  assert.deepEqual(parseCommand('  /STATUS '), { cmd: 'status', args: [] });
  assert.equal(parseCommand('cześć'), null);
});

test('BRAMKA_USERS: format i limity', () => {
  assert.deepEqual([...parseUsers('1:A, 2:B').entries()], [['1', 'A'], ['2', 'B']]);
  assert.throws(() => parseUsers(''), /pusta/);
  assert.throws(() => parseUsers('abc:X'), /id:imię/);
  assert.throws(() => parseUsers('1:a,2:b,3:c,4:d,5:e,6:f'), /5 osób/);
});

test('obcy nadawca i czat grupowy są ignorowane bez odpowiedzi', async () => {
  const { sent, calls, say } = setup();
  await say(OBCY, '/wylacz ksef');
  await say(BARTOSZ, '/wylacz ksef', 'group');
  assert.equal(sent.length, 0);
  assert.equal(calls.disable.length, 0);
});

test('/status: liczby i stan bez danych klientów', async () => {
  const { sent, say } = setup();
  await say(BARTOSZ, '/status');
  const html = sent[0].html;
  assert.match(html, /KSeF: operational/);
  assert.match(html, /Wyłączniki aktywne: killFloAgent/);
  assert.match(html, /Ostatnia migracja: 00100/);
});

test('/kolejki: zaległości i faktury utknięte', async () => {
  const { sent, say } = setup();
  await say(IGOR, '/kolejki');
  assert.match(sent[0].html, /invoice\/submit\.requested<\/code>: czeka 3/);
  assert.match(sent[0].html, /wysyłane &gt; 15 min: 1/);
  assert.match(sent[0].html, /KSEF_PAUSED: 2/);
});

test('/wylacz ksef: flaga przez ops.disable, wykonawca = from.id, powiadomienie drugiej osoby', async () => {
  const { sent, calls, say } = setup();
  await say(BARTOSZ, '/wylacz ksef');
  assert.deepEqual(calls.disable, [{ flag: 'killAllKsefSubmissions', actor: `tg:${BARTOSZ}`, note: 'Telegram: Bartosz' }]);
  assert.equal(sent.find((m) => m.chatId === BARTOSZ).html.startsWith('🛑 Wyłączono wysyłki faktur do KSeF'), true);
  assert.match(sent.find((m) => m.chatId === IGOR).html, /Bartosz wyłączył\(a\) wysyłki/);
});

test('/wylacz z nieznanym celem nic nie zmienia', async () => {
  const { calls, sent, say } = setup();
  await say(BARTOSZ, '/wylacz wszystko');
  assert.equal(calls.disable.length, 0);
  assert.match(sent[0].html, /Użycie: \/wylacz/);
});

test('/wdroz bez argumentów pokazuje plan i instrukcję, niczego nie wdraża', async () => {
  const { sent, calls, say } = setup();
  await say(BARTOSZ, '/wdroz');
  assert.match(sent[0].html, /Do wdrożenia: <code>abcdef12<\/code>/);
  assert.match(sent[0].html, /\/wdroz abcdef12 KOD/);
  assert.equal(calls.start.length, 0);
});

test('/wdroz z błędnym TOTP: odmowa, wpis do dziennika, bez startu', async () => {
  const { sent, calls, say } = setup({ totpOk: false });
  await say(BARTOSZ, '/wdroz abcdef12 000000');
  assert.equal(calls.start.length, 0);
  assert.equal(calls.log[0].action, 'ops.deploy.totp_rejected');
  assert.match(sent[0].html, /Niepoprawny kod TOTP/);
});

test('/wdroz z poprawnym TOTP startuje i powiadamia drugą osobę', async () => {
  const { sent, calls, say } = setup();
  await say(BARTOSZ, '/wdroz ABCDEF12 123456');
  assert.deepEqual(calls.start, [{ sha8: 'abcdef12', actor: `tg:${BARTOSZ}` }]);
  assert.match(sent.find((m) => m.chatId === IGOR).html, /uruchomił\(a\) wdrożenie/);
});

test('/wdroz: zły format SHA nie sprawdza nawet TOTP', async () => {
  const { sent, calls, say } = setup();
  await say(BARTOSZ, '/wdroz main 123456');
  assert.equal(calls.start.length, 0);
  assert.equal(calls.log.length, 0);
  assert.match(sent[0].html, /Użycie: \/wdroz/);
});

test('/wdroz: odmowa deployera trafia do czatu', async () => {
  const { sent, say } = setup({ start: async () => ({ started: false, reason: 'Migracje niewgrane na db-1: 00101' }) });
  await say(BARTOSZ, '/wdroz abcdef12 123456');
  assert.match(sent[0].html, /Nie wdrażam:\nMigracje niewgrane na db-1: 00101/);
});

test('błąd w poleceniu nie wycieka do czatu', async () => {
  const { sent, say } = setup();
  const s = setup({ plan: async () => { throw new Error('Coolify GET /deployments: HTTP 401 token=abc'); } });
  await s.say(BARTOSZ, '/wdroz');
  assert.match(s.sent[0].html, /nie powiodło się\. Szczegóły w logach/);
  assert.doesNotMatch(s.sent[0].html, /token/);
  assert.equal(sent.length, 0);
  await say(BARTOSZ, '/nieznane');
  assert.match(sent[0].html, /Nie znam polecenia/);
});

test('formatPlan: blokady zamiast instrukcji wdrożenia', () => {
  const html = formatPlan({ head: 'abcdef1234', webCommit: null, workerCommit: null, ci: { passed: 8, total: 10 }, commits: [], blockers: ['CI w toku: Next build'] });
  assert.match(html, /Nie można wdrożyć/);
  assert.doesNotMatch(html, /Aby wdrożyć/);
});

test('formatStatus: nieaktualna kopia i brak kopii są oznaczone', () => {
  const old = formatStatus({ backup: { at: '2026-09-29T00:00:00Z' }, flags: {} }, { web: 'x', worker: 'y' }, NOW);
  assert.match(old, /nieaktualna/);
  const none = formatStatus({ flags: {} }, { web: 'x', worker: 'y' }, NOW);
  assert.match(none, /Kopia bazy \(JSON\): brak ⚠️/);
});

test('formatQueues: pusto', () => {
  assert.match(formatQueues([], {}, NOW), /brak zaległości/);
});
