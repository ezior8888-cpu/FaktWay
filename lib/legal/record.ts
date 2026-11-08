import 'server-only';

import { logAudit } from '@/lib/audit/log';
import { sendEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import { siteUrl } from '@/lib/site';
import {
  readLegalMetadata,
  type AcceptanceMethod,
  type EmailConsentCategory,
  type LegalMetadata,
} from '@/lib/legal/acceptance';
import { LEGAL_ENTITY, isLegalEntityComplete } from '@/lib/legal/entity';
import { contractAttachments } from '@/lib/legal/plain-text';
import { CONTRACT_VERSION, MARKETING_STATEMENT, TERMS_STATEMENT } from '@/lib/legal/versions';

/**
 * Zapis akceptacji regulaminu i zgód — tylko serwer, klucz serwisowy
 * (`app_metadata` nie da się zmienić z przeglądarki). Wołają: rejestracja
 * (app/(auth)/register/actions.ts), bramka (/onboarding/zgody), ustawienia
 * powiadomień. Opis modelu danych: lib/legal/acceptance.ts.
 *
 * Ponowienie po każdym kroku jest bezpieczne: zapis metadanych nadpisuje ten
 * sam klucz, wpis w dzienniku może się zdublować (to tylko dowód), a mail
 * z potwierdzeniem ma klucz idempotencji Resend (24 h).
 */

const ALL_EMAIL_CATEGORIES: EmailConsentCategory[] = ['product_updates', 'marketing'];

async function readUser(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return { admin, user: data.user };
}

async function writeLegal(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  legal: LegalMetadata,
): Promise<boolean> {
  // GoTrue scala `app_metadata` po kluczach najwyższego poziomu: `provider`
  // i `providers` zostają, podmieniamy wyłącznie `legal`.
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { legal },
  });
  return !error;
}

export interface RecordTermsInput {
  userId: string;
  method: AcceptanceMethod;
  /** `true` = zaznaczone pole zgody na e-maile. Brak zaznaczenia NIE wycofuje wcześniejszej zgody. */
  marketingConsent?: boolean;
}

export async function recordTermsAcceptance(input: RecordTermsInput): Promise<{ ok: boolean }> {
  const found = await readUser(input.userId);
  if (!found) return { ok: false };
  const { admin, user } = found;

  const now = new Date().toISOString();
  const draft = !isLegalEntityComplete();
  const current = readLegalMetadata(user.app_metadata);
  const next: LegalMetadata = {
    ...current,
    terms: {
      version: CONTRACT_VERSION,
      accepted_at: now,
      draft,
      method: input.method,
      statement_version: TERMS_STATEMENT.version,
    },
  };
  if (input.marketingConsent === true) {
    next.email_consents = { ...current.email_consents };
    for (const category of ALL_EMAIL_CATEGORIES) {
      next.email_consents[category] = {
        granted: true,
        at: now,
        statement_version: MARKETING_STATEMENT.version,
        method: input.method,
      };
    }
  }

  if (!(await writeLegal(admin, input.userId, next))) return { ok: false };

  await logAudit({
    action: 'legal.terms_accepted',
    tenantId: null,
    userId: input.userId,
    metadata: {
      version: CONTRACT_VERSION,
      draft,
      method: input.method,
      statementVersion: TERMS_STATEMENT.version,
    },
  });
  if (input.marketingConsent === true) {
    await logAudit({
      action: 'legal.email_consent_granted',
      tenantId: null,
      userId: input.userId,
      metadata: { categories: ALL_EMAIL_CATEGORIES, statementVersion: MARKETING_STATEMENT.version, method: input.method },
    });
  }

  // Potwierdzenie na trwałym nośniku — tylko dla wersji finalnej: wersji
  // roboczej nie wysyłamy klientom jako „umowy”.
  if (!draft && user.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: `Potwierdzenie zawarcia umowy — ${LEGAL_ENTITY.brand}`,
        html: confirmationHtml(),
        userId: input.userId,
        attachments: contractAttachments(),
        idempotencyKey: `legal-terms/${input.userId}/${CONTRACT_VERSION}`,
      });
    } catch (err) {
      // Akceptacja jest zapisana; brak maila nie może cofnąć umowy. Sentry
      // dostaje błąd z loggera, a klient ma treść na stronie i pod „Pobierz”.
      console.error('[legal] confirmation email failed', err instanceof Error ? err.message : 'unknown');
    }
  }

  return { ok: true };
}

/** Zmiana zgody na e-maile z ustawień (włączenie = zgoda, wyłączenie = wycofanie). */
export async function setEmailConsent(input: {
  userId: string;
  category: EmailConsentCategory;
  granted: boolean;
  method: string;
}): Promise<{ ok: boolean }> {
  const found = await readUser(input.userId);
  if (!found) return { ok: false };
  const current = readLegalMetadata(found.user.app_metadata);
  const next: LegalMetadata = {
    ...current,
    email_consents: {
      ...current.email_consents,
      [input.category]: {
        granted: input.granted,
        at: new Date().toISOString(),
        statement_version: MARKETING_STATEMENT.version,
        method: input.method,
      },
    },
  };
  if (!(await writeLegal(found.admin, input.userId, next))) return { ok: false };
  await logAudit({
    action: input.granted ? 'legal.email_consent_granted' : 'legal.email_consent_withdrawn',
    tenantId: null,
    userId: input.userId,
    metadata: { categories: [input.category], statementVersion: MARKETING_STATEMENT.version, method: input.method },
  });
  return { ok: true };
}

function confirmationHtml(): string {
  const base = siteUrl();
  return `
<p>Dzień dobry,</p>
<p>potwierdzamy zawarcie umowy o świadczenie usług ${LEGAL_ENTITY.brand}. W załącznikach przesyłamy
treść <strong>Regulaminu</strong> i <strong>Umowy powierzenia przetwarzania danych osobowych</strong>
w wersji z dnia ${CONTRACT_VERSION}, które zaakceptowano.</p>
<p><strong>Prawo odstąpienia.</strong> Jeżeli zawierasz umowę jako konsument albo jako przedsiębiorca
na prawach konsumenta, możesz odstąpić od niej bez podawania przyczyny w ciągu 14 dni, wysyłając
oświadczenie na adres ${LEGAL_ENTITY.email}. Wzór formularza jest w załączniku nr 1 do Regulaminu.</p>
<p>Dokumenty są też dostępne w serwisie: <a href="${base}/legal/regulamin">dokumenty prawne FaktWay</a>.</p>
<p>Pytania? Odpisz na tę wiadomość.</p>`;
}
