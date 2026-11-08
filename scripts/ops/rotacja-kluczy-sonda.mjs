/**
 * Sonda działania po kroku rotacji kluczy, uruchamiana WEWNĄTRZ kontenera
 * aplikacji albo workera na app-1 przez `scripts/ops/rotacja-kluczy.sh`:
 *
 *   docker exec -i -e ROTACJA_ROLA=app -e ROTACJA_MAIL_DO=... <kontener> node --input-type=module - < sonda
 *
 * Sekrety czyta z env kontenera i nigdy ich nie wypisuje: na wyjście idą
 * tylko linie `SONDA|<nazwa>|ok|blad|pominiete|<opis>` z kodami HTTP
 * i znanymi kodami błędów, bez treści odpowiedzi.
 *
 * Kontrole (każda niezależna, błąd jednej nie zatrzymuje reszty):
 *   gotrue-anon      GET /auth/v1/settings z kluczem anon (Kong zna klucz)
 *   logowanie        POST /auth/v1/token na nieistniejące konto (tylko app)
 *   gotrue-serwis    GET /auth/v1/admin/users kluczem service_role
 *   postgrest-serwis GET /rest/v1/tenants kluczem service_role
 *   mail             POST api.resend.com/emails (RESEND_API_KEY)
 *   minio            zapis, odczyt i usunięcie obiektu próbnego (R2_*)
 *   minio-kopie      odczyt listy bucketa kopii, gdy R2_BACKUPS_BUCKET inny
 *   turnstile        siteverify z fałszywym tokenem (sekret ważny = odmowa tokenu)
 *   slack-*          POST `{}` na webhook (żywy = 400 no_text, bez wiadomości)
 *
 * Moduł ES ze stdin: w obu obrazach jest Node 22 z `fetch`, a moduły
 * (`@aws-sdk/client-s3`) szukamy od katalogu roboczego kontenera (/app).
 */

import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);

const ROLA = process.env.ROTACJA_ROLA || 'app';
const MAIL_DO = process.env.ROTACJA_MAIL_DO || 'delivered@resend.dev';
const TIMEOUT_MS = 15000;

function wynik(nazwa, stan, opis) {
  // `|` i nowe linie rozbiłyby format; opis składamy sami, ale na wszelki wypadek.
  console.log(`SONDA|${nazwa}|${stan}|${String(opis).replace(/[|\r\n]+/g, ' ')}`);
}

function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : '';
}

async function http(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  return { status: res.status, body };
}

/** Kod błędu z odpowiedzi JSON (GoTrue: `code`/`error_code`, Slack: tekst). Bez reszty treści. */
function kodBledu(body) {
  try {
    const j = JSON.parse(body);
    const c = j.error_code || j.code || j.error || j.name;
    return typeof c === 'string' ? c.slice(0, 60) : '';
  } catch {
    return /^[a-z_]{2,40}$/.test(body.trim()) ? body.trim() : '';
  }
}

/**
 * Błąd kontroli opisujemy samą nazwą wyjątku: dla S3 to kod w rodzaju
 * `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `AccessDenied`. Komunikat
 * (`message`) pomijamy, bo bywa w nim adres albo fragment odpowiedzi.
 */
async function kontrola(nazwa, fn) {
  try {
    await fn();
  } catch (e) {
    const przyczyna = e && e.cause && typeof e.cause.code === 'string' ? e.cause.code : '';
    const kod = e && typeof e.code === 'string' ? e.code : przyczyna;
    const nazwa_ = e && e.name === 'TimeoutError' ? 'przekroczony czas' : (e && e.name) || 'wyjątek';
    const rodzaj = kod && kod !== nazwa_ ? `${nazwa_} ${kod}` : nazwa_;
    wynik(nazwa, 'blad', rodzaj.slice(0, 80));
  }
}

async function gotrue() {
  const url = env('NEXT_PUBLIC_SUPABASE_URL');
  const anon = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url) {
    wynik('gotrue-anon', 'pominiete', 'brak NEXT_PUBLIC_SUPABASE_URL w env');
    return;
  }

  if (anon) {
    await kontrola('gotrue-anon', async () => {
      const r = await http(`${url}/auth/v1/settings`, { headers: { apikey: anon } });
      if (r.status === 200) {
        let google = '?';
        try {
          google = JSON.parse(r.body).external?.google ? 'włączony' : 'wyłączony';
        } catch {
          /* bez opisu Google */
        }
        wynik('gotrue-anon', 'ok', `klucz anon przyjęty (200), Google: ${google}`);
      } else {
        wynik('gotrue-anon', 'blad', `HTTP ${r.status} ${kodBledu(r.body)}: Kong/GoTrue odrzuca klucz anon`);
      }
    });

    // Jedna próba logowania na przebieg i tylko z aplikacji: GoTrue liczy
    // próby po adresie, a worker i aplikacja wychodzą z tego samego serwera.
    if (ROLA === 'app') {
      await kontrola('logowanie', async () => {
        const r = await http(`${url}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { apikey: anon, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'kontrola-rotacji@example.invalid', password: 'kontrola-rotacji-zle-haslo' }),
        });
        const kod = kodBledu(r.body);
        if (kod === 'invalid_credentials' || /invalid login credentials/i.test(r.body)) {
          wynik('logowanie', 'ok', `GoTrue sprawdza hasła (HTTP ${r.status}, złe dane → odmowa)`);
        } else if (/captcha/i.test(r.body)) {
          wynik('logowanie', 'ok', `GoTrue odpowiada (HTTP ${r.status}, wymaga captcha)`);
        } else if (r.status === 429) {
          wynik('logowanie', 'pominiete', 'HTTP 429: limit prób GoTrue, powtórz za kilka minut');
        } else {
          wynik('logowanie', 'blad', `HTTP ${r.status} ${kod}: logowanie nie działa`);
        }
      });
    }
  } else {
    wynik('gotrue-anon', 'pominiete', 'brak NEXT_PUBLIC_SUPABASE_ANON_KEY w env');
  }

  if (!service) {
    wynik('gotrue-serwis', ROLA === 'app' ? 'blad' : 'pominiete', 'brak SUPABASE_SERVICE_ROLE_KEY w env');
    return;
  }
  const auth = { apikey: service, Authorization: `Bearer ${service}` };
  await kontrola('gotrue-serwis', async () => {
    const r = await http(`${url}/auth/v1/admin/users?page=1&per_page=1`, { headers: auth });
    if (r.status === 200) wynik('gotrue-serwis', 'ok', 'klucz service_role przyjęty przez GoTrue (200)');
    else wynik('gotrue-serwis', 'blad', `HTTP ${r.status} ${kodBledu(r.body)}: GoTrue odrzuca klucz service_role`);
  });
  await kontrola('postgrest-serwis', async () => {
    const r = await http(`${url}/rest/v1/tenants?select=id&limit=1`, { headers: auth });
    if (r.status === 200) wynik('postgrest-serwis', 'ok', 'klucz service_role przyjęty przez PostgREST (200)');
    else wynik('postgrest-serwis', 'blad', `HTTP ${r.status} ${kodBledu(r.body)}: PostgREST odrzuca klucz service_role`);
  });
}

async function mail() {
  const key = env('RESEND_API_KEY');
  const from = env('RESEND_FROM_TRANSACTIONAL') || env('RESEND_FROM_EMAIL');
  if (!key) {
    wynik('mail', 'blad', 'brak RESEND_API_KEY w env (maile z tego kontenera nie wychodzą)');
    return;
  }
  if (!from) {
    wynik('mail', 'blad', 'brak RESEND_FROM_TRANSACTIONAL i RESEND_FROM_EMAIL w env');
    return;
  }
  await kontrola('mail', async () => {
    const teraz = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const r = await http('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [MAIL_DO],
        subject: `FaktWay: kontrola rotacji kluczy (${ROLA}, ${teraz} UTC)`,
        text: `Mail kontrolny ze skryptu scripts/ops/rotacja-kluczy.sh, kontener: ${ROLA}. Nie wymaga odpowiedzi.`,
      }),
    });
    if (r.status === 200) {
      let id = '';
      try {
        id = String(JSON.parse(r.body).id || '');
      } catch {
        /* bez identyfikatora */
      }
      wynik('mail', 'ok', `Resend przyjął mail do ${MAIL_DO}${id ? ` (id ${id})` : ''}`);
    } else {
      wynik('mail', 'blad', `HTTP ${r.status} ${kodBledu(r.body)}: Resend odrzucił wysyłkę`);
    }
  });
}

async function minio() {
  const bucket = env('R2_BUCKET_NAME');
  const endpoint = env('R2_ENDPOINT');
  const id = env('R2_ACCESS_KEY_ID');
  const secret = env('R2_SECRET_ACCESS_KEY');
  if (!bucket || !endpoint || !id || !secret) {
    wynik('minio', 'blad', 'brak R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID albo R2_SECRET_ACCESS_KEY w env');
    return;
  }
  let s3;
  try {
    // Ta sama biblioteka i te same ustawienia co lib/storage/r2-client.ts.
    s3 = require('@aws-sdk/client-s3');
  } catch {
    wynik('minio', 'pominiete', 'brak @aws-sdk/client-s3 w obrazie tego kontenera');
    return;
  }
  const client = new s3.S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: env('R2_FORCE_PATH_STYLE') === 'true',
    credentials: { accessKeyId: id, secretAccessKey: secret },
  });
  const opts = { abortSignal: AbortSignal.timeout(TIMEOUT_MS) };

  await kontrola('minio', async () => {
    const key = `_kontrola-rotacji/${ROLA}-${Date.now()}.txt`;
    const tresc = `kontrola rotacji ${new Date().toISOString()}`;
    await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: tresc, ContentType: 'text/plain' }), opts);
    let odczyt;
    try {
      const got = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }), opts);
      odczyt = await got.Body.transformToString();
    } finally {
      // Usuwamy też po nieudanym odczycie; błąd usunięcia zgłasza sama kontrola.
      await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
    if (odczyt === tresc) wynik('minio', 'ok', `zapis, odczyt i usunięcie obiektu próbnego w buckecie ${bucket}`);
    else wynik('minio', 'blad', 'odczytany obiekt różni się od zapisanego');
  });

  const kopie = env('R2_BACKUPS_BUCKET');
  if (kopie && kopie !== bucket) {
    await kontrola('minio-kopie', async () => {
      await client.send(new s3.ListObjectsV2Command({ Bucket: kopie, MaxKeys: 1 }), opts);
      wynik('minio-kopie', 'ok', `odczyt listy bucketa kopii ${kopie}`);
    });
  }
}

async function turnstile() {
  const secret = env('TURNSTILE_SECRET_KEY');
  if (!secret) {
    if (ROLA === 'app') wynik('turnstile', 'blad', 'brak TURNSTILE_SECRET_KEY w env aplikacji');
    return;
  }
  await kontrola('turnstile', async () => {
    const r = await http('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: 'kontrola-rotacji-falszywy-token' }).toString(),
    });
    let kody = [];
    try {
      kody = JSON.parse(r.body)['error-codes'] || [];
    } catch {
      /* puste */
    }
    if (kody.includes('invalid-input-secret')) {
      wynik('turnstile', 'blad', 'Cloudflare: sekret Turnstile nieważny (invalid-input-secret)');
    } else if (kody.includes('invalid-input-response')) {
      wynik('turnstile', 'ok', 'sekret Turnstile ważny (fałszywy token odrzucony jako token)');
    } else {
      wynik('turnstile', 'blad', `HTTP ${r.status}, kody: ${kody.join(',') || 'brak'}`);
    }
  });
}

async function slack() {
  for (const name of ['SLACK_WEBHOOK_URGENT', 'SLACK_WEBHOOK_BUGS', 'SLACK_WEBHOOK_METRICS']) {
    const url = env(name);
    const nazwa = `slack-${name.slice('SLACK_WEBHOOK_'.length).toLowerCase()}`;
    if (!url) continue;
    await kontrola(nazwa, async () => {
      // Pusty JSON: żywy webhook odpowiada 400 `no_text` i nic nie publikuje.
      const r = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const kod = kodBledu(r.body);
      if (r.status === 400 && (kod === 'no_text' || kod === 'invalid_payload')) {
        wynik(nazwa, 'ok', `webhook żyje (400 ${kod}, nic nie opublikowano)`);
      } else {
        wynik(nazwa, 'blad', `HTTP ${r.status} ${kod}: webhook nieważny albo usunięty`);
      }
    });
  }
}

try {
  await gotrue();
  await mail();
  await minio();
  await turnstile();
  await slack();
} catch {
  wynik('sonda', 'blad', 'nieoczekiwany wyjątek sondy');
}
