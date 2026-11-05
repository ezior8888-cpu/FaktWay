// lib/jobs/runners/co-pilot-monthly.ts
// Cron: codziennie 8:00 Europe/Warsaw — uruchamia paczkę u tenantów z send_day_of_month = dziś
// + job obsługujący event exports/co-pilot.send-package

import { NonRetriableError } from '../errors';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import type { JobContext } from '@/lib/jobs/registry';
import { Resend } from 'resend';

import {
  exportsCoPilotSendPackage,
  exportsGenerateRequested,
} from '@/lib/jobs/events';
import { jpkFaBlocker } from '@/lib/exports/jpk-fa-readiness';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { replacementForFormat } from '@/lib/exports/suspended-formats';
import { readAllById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/admin';
import { downloadFromR2, getSignedInvoiceUrl } from '@/lib/storage/r2';
import type { Database } from '@/types/database';

type ExportFormat = Database['public']['Enums']['export_format_enum'];
type AccountantSettingsRow = Database['public']['Tables']['accountant_settings']['Row'];

const VALID_FORMATS: readonly ExportFormat[] = [
  'jpk_fa',
  'kpir_excel',
  'comarch_optima',
  'insert_subiekt',
  'symfonia',
  'wapro',
  'csv_universal',
] as const;

const DEV_TO_OVERRIDE = process.env.RESEND_DEV_TO_OVERRIDE?.trim() || null;

/**
 * Limit rozmiaru łączny dla załączników w jednym mailu.
 *
 * Resend dokumentuje twardy limit 40 MB. Trzymamy się 25 MB jako budżet
 * (spam-filtry korporacyjne często cinają już od 20-30 MB) — powyżej tej
 * wartości przerzucamy się na pre-signed URL-e R2 (7 dni ważności).
 */
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Wykładnicza skala backoffu (sekundy) dla pollingu statusu eksportu.
 *
 * Zamiast 60 × 5 s (sztywne 5 min, niepotrzebnie powolne dla małych paczek
 * i niewystarczające dla bardzo dużych), zaczynamy od 1 s i powoli rosniemy
 * do 60 s. Dla typowych eksportów (kilka faktur) skończymy w ≤30 s, a
 * giga-paczki (lata danych) dostają do ~24 min budżetu.
 */
const POLL_DELAYS_SEC: readonly number[] = [
  1, 2, 4, 8, 16, 30, 60, 60, 60,
] as const;
const POLL_MAX_ATTEMPTS = 30;

function isExportFormat(v: string): v is ExportFormat {
  return (VALID_FORMATS as readonly string[]).includes(v);
}

/**
 * Formaty z ustawień paczki. Wstrzymany format (`suspended-formats.ts`)
 * zamienia się w to, co program księgowej naprawdę importuje (Symfonia,
 * Wapro → JPK_FA; reszta → uniwersalny CSV) — ustawienia zapisane przed
 * wstrzymaniem nie mogą wysłać pliku, którego program nie przyjmie. JPK_FA
 * przechodzi dalej przez bramki gotowości i w razie odmowy staje się CSV.
 */
export function parseFormats(formats: string[] | null | undefined): ExportFormat[] {
  return [
    ...new Set(
      (formats ?? [])
        .filter(isExportFormat)
        // Symfonia/Wapro → JPK_FA (to importują), reszta wstrzymanych → CSV.
        .map((f) => replacementForFormat(f)),
    ),
  ];
}

/**
 * Bez urzędu skarbowego firmy JPK_FA odmawia (#67) — w paczce zastępuje go
 * uniwersalny CSV, zamiast wywracać całą paczkę dla księgowej.
 */
export function formatsWithoutUnaddressedJpkFa<F extends string>(
  formats: readonly F[],
  taxOfficeCode: string | null,
): F[] {
  return taxOfficeCode ? [...formats] : formatsWithCsvInsteadOfJpkFa(formats);
}

/** JPK_FA → uniwersalny CSV (bez dubla, gdy CSV już jest w paczce). */
export function formatsWithCsvInsteadOfJpkFa<F extends string>(formats: readonly F[]): F[] {
  if (!formats.includes('jpk_fa' as F)) return [...formats];
  return [...new Set(formats.map((f) => (f === 'jpk_fa' ? ('csv_universal' as F) : f)))];
}

/** Dzień miesiąca (1–31) w kalendarzu Europe/Warsaw. */
function dayOfMonthInWarsaw(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    day: 'numeric',
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day')?.value;
  return day ? Number.parseInt(day, 10) : d.getUTCDate();
}

/**
 * Zakres poprzedniego miesiąca kalendarzowego wg Europe/Warsaw (YYYY-MM-DD).
 * Np. uruchomienie 2026-02-05 → 2026-01-01 .. 2026-01-31.
 */
function previousMonthRangeWarsaw(reference: Date): {
  periodStart: string;
  periodEnd: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);

  let prevY = year;
  let prevM = month - 1;
  if (prevM < 1) {
    prevM = 12;
    prevY -= 1;
  }

  const start = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const end = `${prevY}-${String(prevM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return { periodStart: start, periodEnd: end };
}

// ============================================================================
// Cron: miesięcznie wg send_day_of_month (filtr dzienny 8:00)
// ============================================================================

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts
 */
export async function runCoPilotMonthly({ step }: JobContext) {
    const supabase = createAdminClient();

    const dayOfMonth = await step.run('warsaw-day', () => dayOfMonthInWarsaw(new Date()));

    // Stronami po kluczu (sesja 27 planu skalowania, JOB-11): jedno zapytanie
    // oddawało najwyżej 1000 firm (PGRST_DB_MAX_ROWS). Domyślny dzień wysyłki
    // to 5., więc reszta traciła paczkę za cały miesiąc — jutro filtr dnia
    // już jej nie łapie. Błąd dowolnej strony = wyjątek przed pierwszą
    // rezerwacją; ponowienie (cały handler od nowa) pomija firmy już
    // zarezerwowane dzięki warunkowi na okresie niżej.
    const tenantsToProcess = await step.run('find-tenants', () =>
      readAllById<AccountantSettingsRow>('Co-Pilot: odczyt ustawień firm', (afterId, limit) => {
        let query = supabase
          .from('accountant_settings')
          .select('*')
          .eq('co_pilot_enabled', true)
          .eq('send_day_of_month', dayOfMonth);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      }),
    );

    if (tenantsToProcess.length === 0) {
      return {
        skipped: true as const,
        reason: 'Brak tenants do procesowania',
      };
    }

    const { periodStart, periodEnd } = previousMonthRangeWarsaw(new Date());

    let triggered = 0;

    for (const settings of tenantsToProcess) {
      const email = settings.accountant_email?.trim();
      if (!email) continue;

      const formats = parseFormats(settings.preferred_formats ?? undefined);
      if (formats.length === 0) continue;

      // Atomowa rezerwacja okresu (CAS-like UPDATE).
      //
      // PRZED: w pętli polegaliśmy na `settings.last_sent_period_*` z poprzedniego
      // SELECT-a. Między fan-outem a ukończeniem `update-settings` w jobie
      // `coPilotSendPackageJob` (kilka minut później) drugi cron lub manualny
      // trigger mogły wysłać DUPLIKAT paczki za ten sam miesiąc.
      //
      // PO: jeden zatomizowany UPDATE z warunkiem `OR (period != ours, period IS NULL)`.
      // Drugi wykonujący się równolegle nie znajdzie wiersza i zwróci 0 rekordów —
      // wtedy `reserved=false` i pomijamy fan-out. Zwycięzca wyścigu wysyła paczkę,
      // przegrany mija.
      //
      // Rezerwacja i wysłanie zdarzenia idą w JEDNYM kroku. pg-boss ponawia
      // cały job od nowa (bez pamięci kroków): gdy rezerwacje szły osobno,
      // a zdarzenia jednym wysłaniem na końcu, błąd po drodze (chwilowy błąd
      // bazy przy kolejnej firmie, nieudane wysłanie) zostawiał okres
      // zarezerwowany bez zdarzenia. Ponowienie widziało rezerwację i pomijało
      // firmę — paczka za ten miesiąc nie wychodziła wcale (do 01.10.2026).
      // Teraz zdarzenie wychodzi zaraz po rezerwacji, a gdy wysłanie się nie
      // uda, rezerwacja wraca do poprzedniego okresu i ponowienie próbuje znowu.
      const sent = await step.run(
        `reserve-and-send-${settings.tenant_id}`,
        async (): Promise<boolean> => {
          const { data, error } = await supabase
            .from('accountant_settings')
            .update({
              last_sent_period_start: periodStart,
              last_sent_period_end: periodEnd,
            })
            .eq('tenant_id', settings.tenant_id)
            .eq('co_pilot_enabled', true)
            .or(
              [
                `last_sent_period_start.neq.${periodStart}`,
                `last_sent_period_end.neq.${periodEnd}`,
                'last_sent_period_start.is.null',
                'last_sent_period_end.is.null',
              ].join(','),
            )
            .select('tenant_id');

          if (error) throw new Error(error.message);
          if (!data || data.length === 0) return false;

          try {
            await sendJobEvent(
              exportsCoPilotSendPackage.create({
                tenantId: settings.tenant_id,
                periodStart,
                periodEnd,
                formats,
                accountantEmail: email,
                accountantName: settings.accountant_name,
                manual: false,
              }),
            );
          } catch (sendError) {
            const { error: releaseError } = await supabase
              .from('accountant_settings')
              .update({
                last_sent_period_start: settings.last_sent_period_start,
                last_sent_period_end: settings.last_sent_period_end,
              })
              .eq('tenant_id', settings.tenant_id)
              .eq('last_sent_period_start', periodStart)
              .eq('last_sent_period_end', periodEnd);
            if (releaseError) {
              console.error('[co-pilot] nie udało się zwolnić rezerwacji okresu — paczka nie wyjdzie', {
                tenantId: settings.tenant_id,
                periodStart,
              });
            }
            throw sendError;
          }
          return true;
        },
      );

      if (sent) triggered++;
    }

    return {
      processed: tenantsToProcess.length,
      triggered,
      periodStart,
      periodEnd,
    };
}

// ============================================================================
// Paczka per tenant (manual lub z crona)
// ============================================================================

interface CoPilotAttachment {
  filename: string;
  content: Buffer;
}

interface CoPilotDownloadLink {
  filename: string;
  url: string;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts
 */
export async function runCoPilotSendPackage(data: Parameters<typeof exportsCoPilotSendPackage.create>[0], { step }: JobContext) {
    const {
      tenantId,
      periodStart,
      periodEnd,
      formats: rawFormats,
      accountantEmail,
      accountantName,
      manual,
    } = data;

    const supabase = createAdminClient();

    const settingsRow = await step.run('fetch-accountant-settings', async () => {
      const { data, error } = await supabase
        .from('accountant_settings')
        .select('*')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data as AccountantSettingsRow | null;
    });

    // Paczka z crona wychodzi raz na okres. pg-boss ponawia job od nowa: gdy
    // mail już wyszedł, a padł późniejszy krok (licznik paczek, ustawienia),
    // drugi przebieg tworzył nowe eksporty i wysyłał księgowej tę samą paczkę
    // jeszcze raz (do 01.10.2026). Znacznik wysyłki: `export_jobs.emailed_at`.
    // Ręczne wysłanie z ustawień zawsze idzie — to świadoma decyzja klienta.
    if (!manual) {
      const alreadyEmailed = await step.run('check-already-emailed', async () => {
        const { data, error } = await supabase
          .from('export_jobs')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('trigger_source', 'co_pilot_monthly')
          .eq('period_start', periodStart)
          .eq('period_end', periodEnd)
          .not('emailed_at', 'is', null)
          .limit(1);
        if (error) throw new Error(error.message);
        return (data ?? []).length > 0;
      });
      if (alreadyEmailed) {
        return { success: true as const, skipped: 'already-emailed' as const };
      }
    }

    const formats =
      rawFormats.length > 0
        ? parseFormats(rawFormats)
        : parseFormats(settingsRow?.preferred_formats ?? undefined);

    if (formats.length === 0) {
      throw new NonRetriableError('Brak formatów eksportu (Co-Pilot)');
    }

    // JPK_FA bez urzędu firmy odmawia — a jeden nieudany format wywraca całą
    // paczkę. Bez urzędu księgowa dostaje zamiast JPK_FA uniwersalny CSV.
    const taxOfficeCode = formats.includes('jpk_fa')
      ? await step.run('read-tax-office', () => readTenantTaxOffice(supabase, tenantId))
      : null;
    const addressedFormats = formatsWithoutUnaddressedJpkFa(formats, taxOfficeCode);
    // JPK_FA odmawia też przy korekcie w okresie (C-01) i bez adresu w GUS —
    // sprawdzone tutaj z tego samego powodu: paczka ma dojść do księgowej.
    const jpkFaBlocked = addressedFormats.includes('jpk_fa')
      ? await step.run('check-jpk-fa', () =>
          jpkFaBlocker(supabase, {
            tenantId,
            periodStart,
            periodEnd,
            includeCorrections: settingsRow?.include_corrections ?? true,
          }),
        )
      : null;
    const packageFormats = jpkFaBlocked ? formatsWithCsvInsteadOfJpkFa(addressedFormats) : addressedFormats;

    const toEmail = accountantEmail.trim() || settingsRow?.accountant_email?.trim();
    if (!toEmail) {
      throw new NonRetriableError('Brak adresu email księgowego');
    }

    const includeIssued = settingsRow?.include_issued_invoices ?? true;
    const includeReceived = settingsRow?.include_received_invoices ?? true;
    const includeCorrections = settingsRow?.include_corrections ?? true;

    const triggerSource: Database['public']['Enums']['export_trigger_enum'] =
      manual ? 'manual' : 'co_pilot_monthly';

    const jobIds: string[] = [];

    for (let i = 0; i < packageFormats.length; i++) {
      const format = packageFormats[i];
      const id = await step.run(`create-job-${format}-${i}`, async () => {
        const { data, error } = await supabase
          .from('export_jobs')
          .insert({
            tenant_id: tenantId,
            format,
            trigger_source: triggerSource,
            period_start: periodStart,
            period_end: periodEnd,
            include_issued: includeIssued,
            include_received: includeReceived,
            include_corrections: includeCorrections,
            status: 'pending',
            emailed_to: toEmail,
          })
          .select('id')
          .single();

        if (error) throw new Error(error.message);
        return data?.id;
      });
      if (id) jobIds.push(id);
    }

    if (jobIds.length === 0) {
      throw new NonRetriableError('Nie utworzono jobów eksportu');
    }

    // Batch fan-out zamiast jednego eventu per format — jeden round-trip
    // do Inngest niezależnie od liczby formatów.
    await step.sendEvent(
      'generate-fanout',
      jobIds.map((jobId) => exportsGenerateRequested.create({ exportJobId: jobId })),
    );

    // Polling z eksponencjalnym backoffem zamiast sztywnego 5s × 60.
    // Małe paczki kończą się w ≤30 s, duże dostają budżet ≈24 min.
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      if (i > 0) {
        const sec = POLL_DELAYS_SEC[Math.min(i - 1, POLL_DELAYS_SEC.length - 1)];
        await step.sleep(`co-pilot-poll-wait-${i}`, `${sec}s`);
      }

      const poll = await step.run(`poll-export-jobs-${i}`, async () => {
        const { data: jobs, error } = await supabase
          .from('export_jobs')
          .select('id, status')
          .in('id', jobIds);

        if (error) throw new Error(error.message);
        return jobs ?? [];
      });

      if (poll.length < jobIds.length) continue;

      if (poll.some((j) => j.status === 'failed')) {
        throw new NonRetriableError(
          'Co najmniej jeden eksport zakończył się błędem',
        );
      }

      if (poll.every((j) => j.status === 'completed')) {
        break;
      }

      if (i === POLL_MAX_ATTEMPTS - 1) {
        throw new Error('Timeout oczekiwania na eksport (polling wyczerpany)');
      }
    }

    const sendResult = await step.run('download-and-email', async () => {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey || apiKey.startsWith('re_xxxx')) {
        throw new NonRetriableError('RESEND nie skonfigurowany');
      }

      const fromEmail = process.env.RESEND_FROM_EMAIL?.trim();
      if (!fromEmail) {
        throw new NonRetriableError(
          'Brak zmiennej RESEND_FROM_EMAIL (nadawca paczki Co-Pilot)',
        );
      }

      const { data: files, error } = await supabase
        .from('export_files')
        .select('*')
        .in('export_job_id', jobIds)
        .eq('tenant_id', tenantId);

      if (error) throw new Error(error.message);
      if (!files || files.length === 0) {
        throw new NonRetriableError('Brak plików do załączenia');
      }

      // Sumaryczny rozmiar liczymy z `size_bytes` w DB (tańsze niż HEAD do R2).
      // Powyżej budżetu — pre-signed URLe zamiast attachów (Resend i tak by się
      // wywalił przy 40 MB+, a księgowa woli 1 mail z linkami niż trzy errory).
      const totalBytes = files.reduce(
        (sum, f) => sum + Number(f.size_bytes ?? 0),
        0,
      );

      const attachments: CoPilotAttachment[] = [];
      const downloadLinks: CoPilotDownloadLink[] = [];

      if (totalBytes <= MAX_TOTAL_ATTACHMENT_BYTES) {
        for (const file of files) {
          const buffer = await downloadFromR2(file.r2_path, tenantId);
          attachments.push({ filename: file.filename, content: buffer });
        }
      } else {
        const ttlSeconds = 7 * 24 * 3600;
        for (const file of files) {
          const url = await getSignedInvoiceUrl(file.r2_path, tenantId, ttlSeconds);
          downloadLinks.push({ filename: file.filename, url });
        }
      }

      const { data: tenant, error: tenErr } = await supabase
        .from('tenants')
        .select('name, nip')
        .eq('id', tenantId)
        .single();

      if (tenErr || !tenant) {
        throw new NonRetriableError(`Tenant ${tenantId} nie znaleziony`);
      }

      const resend = new Resend(apiKey);
      const periodLabel = periodStart.slice(0, 7);
      const displayName =
        accountantName?.trim() || settingsRow?.accountant_name || '';

      const itemsHtml =
        attachments.length > 0
          ? attachments
              .map((f) => `<li>${escapeHtml(f.filename)}</li>`)
              .join('')
          : downloadLinks
              .map(
                (f) =>
                  `<li><a href="${escapeHtmlAttr(f.url)}">${escapeHtml(f.filename)}</a> <span style="color:#888;font-size:12px;">(link aktywny 7 dni)</span></li>`,
              )
              .join('');

      const transferNote =
        attachments.length > 0
          ? '<p>Paczka obejmuje faktury zgodnie z ustawieniami eksportu w koncie tenant.</p>'
          : `<p style="background:#FFF8E1;border:1px solid #FFE082;border-radius:8px;padding:12px;">
                Paczka jest większa niż 25&nbsp;MB i nie mieściła się w załącznikach.
                Pobierz pliki bezpośrednio z naszego storage'u — każdy link jest aktywny
                <strong>7 dni</strong>, po czym wygaśnie.
             </p>`;

      const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #333;">
  <h2>Paczka księgowa za ${escapeHtml(periodLabel)}</h2>
  <p>Dzień dobry ${escapeHtml(displayName)},</p>
  <p>
    W ${attachments.length > 0 ? 'załączniku' : 'linkach poniżej'} znajduje się paczka dokumentów księgowych firmy
    <strong>${escapeHtml(tenant.name)}</strong> (NIP: ${escapeHtml(tenant.nip)})
    za okres <strong>${escapeHtml(periodStart)} — ${escapeHtml(periodEnd)}</strong>.
  </p>
  ${transferNote}
  <p><strong>${attachments.length > 0 ? 'Załączniki' : 'Pliki'}:</strong></p>
  <ul>
    ${itemsHtml}
  </ul>
  <p style="color: #666; font-size: 13px; margin-top: 32px;">
    Email wygenerowany automatycznie przez FaktWay.<br/>
    W razie pytań prosimy o kontakt z właścicielem konta.
  </p>
</body>
</html>`;

      const recipient = DEV_TO_OVERRIDE ?? toEmail;
      const subject = DEV_TO_OVERRIDE
        ? `[DEV → ${toEmail}] Paczka księgowa za ${periodLabel} - ${tenant.name}`
        : `Paczka księgowa za ${periodLabel} - ${tenant.name}`;

      const ccList = (settingsRow?.cc_emails ?? []).filter(
        (e): e is string => typeof e === 'string' && e.includes('@'),
      );

      const result = await resend.emails.send({
        from: fromEmail,
        to: recipient,
        cc:
          ccList.length > 0 && !DEV_TO_OVERRIDE ? ccList : undefined,
        subject,
        html,
        attachments:
          attachments.length > 0
            ? attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
              }))
            : undefined,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      // Znacznik dla ponowienia (patrz `check-already-emailed`) i dla historii
      // paczek w ustawieniach — UI czytało `emailed_at`, ale nikt go nie
      // zapisywał. Mail już wyszedł, więc błąd zapisu tylko logujemy.
      const { error: markError } = await supabase
        .from('export_jobs')
        .update({ emailed_at: new Date().toISOString() })
        .in('id', jobIds)
        .eq('tenant_id', tenantId);
      if (markError) {
        console.error('[co-pilot] paczka wysłana, ale nie zapisano emailed_at', { tenantId, periodStart });
      }

      return {
        deliveryMode:
          attachments.length > 0
            ? ('attachments' as const)
            : ('signed-urls' as const),
        filesCount: attachments.length + downloadLinks.length,
        totalBytes,
      };
    });

    await step.run('update-settings', async () => {
      // Atomowy increment przez RPC (00025_increment_packages_sent.sql).
      //
      // PRZED: SELECT total_packages_sent → +1 → UPDATE. Dwie współbieżne paczki
      // (manual + cron, manual × 2, retry pakietu) odczytywały tę samą wartość
      // i nadpisywały się nawzajem — utracony increment.
      //
      // PO: jedno UPDATE w bazie, bez race condition. `last_sent_period_*` jest
      // już ustawione przez `reserve-` step crona, ale powtarzamy tu, żeby
      // ścieżka manual (która nie przechodzi przez crona) też zaktualizowała
      // okres ostatniej wysyłki.
      const { error: rpcError } = await supabase.rpc(
        'increment_packages_sent',
        { p_tenant_id: tenantId },
      );
      if (rpcError) throw new Error(rpcError.message);

      const { error } = await supabase
        .from('accountant_settings')
        .update({
          last_sent_at: new Date().toISOString(),
          last_sent_period_start: periodStart,
          last_sent_period_end: periodEnd,
        })
        .eq('tenant_id', tenantId);

      if (error) throw new Error(error.message);
    });

    return {
      success: true as const,
      filesCount: sendResult.filesCount,
      deliveryMode: sendResult.deliveryMode,
      totalBytes: sendResult.totalBytes,
      emailedTo: toEmail,
    };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape do atrybutu HTML (np. `href="..."`).
 *
 * Dodatkowo blokujemy URL-e bez schematu http/https — pre-signed URL z R2
 * zawsze jest `https://`, więc każdy inny scheme to potencjalny wektor (np.
 * `javascript:` w razie kompromisu generatora linków).
 */
function escapeHtmlAttr(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '#';
    }
    return escapeHtml(parsed.toString());
  } catch {
    return '#';
  }
}
