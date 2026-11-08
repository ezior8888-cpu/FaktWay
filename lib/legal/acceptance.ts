import { z } from 'zod';

import { isLegalEntityComplete } from '@/lib/legal/entity';
import { CONTRACT_VERSION } from '@/lib/legal/versions';

/**
 * Stan akceptacji dokumentów i zgód — w `app_metadata.legal` konta GoTrue.
 *
 * Dlaczego `app_metadata`, a nie `user_metadata`: tę drugą użytkownik może
 * zmienić sam (`auth.updateUser`), więc mógłby „zaakceptować” cokolwiek bez
 * przechodzenia przez formularz. `app_metadata` zapisuje wyłącznie serwer
 * kluczem serwisowym (lib/legal/record.ts). Odczyt jest darmowy — przychodzi
 * z `auth.getUser()`, które layout panelu i tak wywołuje.
 *
 * Dlaczego nie tylko `audit_logs`: dziennik jest czyszczony po 12 miesiącach
 * (cron.cleanup-audit-logs), a dowód zawarcia umowy jest potrzebny przez cały
 * czas jej trwania i do przedawnienia roszczeń. Docelowo osobna tabela —
 * prośba o migrację w memo dla prawnika i opisie PR.
 */

export type AcceptanceMethod = 'register_form' | 'gate' | 'checkout';
export type EmailConsentCategory = 'product_updates' | 'marketing';

const termsSchema = z.object({
  version: z.string(),
  accepted_at: z.string(),
  /** Akceptacja wersji roboczej (dane usługodawcy niepełne) — nie spełnia bramki. */
  draft: z.boolean(),
  method: z.enum(['register_form', 'gate', 'checkout']),
  statement_version: z.string(),
});

const emailConsentSchema = z.object({
  granted: z.boolean(),
  at: z.string(),
  statement_version: z.string(),
  method: z.string(),
});

const legalMetadataSchema = z.object({
  terms: termsSchema.optional(),
  email_consents: z
    .object({
      product_updates: emailConsentSchema.optional(),
      marketing: emailConsentSchema.optional(),
    })
    .optional(),
});

export type LegalMetadata = z.infer<typeof legalMetadataSchema>;
export type TermsAcceptance = z.infer<typeof termsSchema>;
export type EmailConsent = z.infer<typeof emailConsentSchema>;

/** Odczyt odporny na stare i uszkodzone wpisy: zły kształt = brak akceptacji. */
export function readLegalMetadata(appMetadata: unknown): LegalMetadata {
  if (!appMetadata || typeof appMetadata !== 'object') return {};
  const raw = (appMetadata as Record<string, unknown>).legal;
  const parsed = legalMetadataSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Czy konto musi (jeszcze raz) zaakceptować regulamin.
 *
 * Dopóki dane usługodawcy są niepełne, bramka śpi: dokumenty są projektem
 * i nikt nie powinien zawierać na ich podstawie umowy. Po uzupełnieniu
 * danych każdy bez akceptacji BIEŻĄCEJ, nie-roboczej wersji przechodzi przez
 * /onboarding/zgody — także konta sprzed wprowadzenia dokumentów.
 */
export function needsTermsAcceptance(
  appMetadata: unknown,
  opts: { entityComplete?: boolean; currentVersion?: string } = {},
): boolean {
  const entityComplete = opts.entityComplete ?? isLegalEntityComplete();
  if (!entityComplete) return false;
  const terms = readLegalMetadata(appMetadata).terms;
  if (!terms) return true;
  return terms.draft || terms.version !== (opts.currentVersion ?? CONTRACT_VERSION);
}

/** Zgoda na e-maile danej kategorii (art. 398 Prawa komunikacji elektronicznej). */
export function hasEmailConsent(appMetadata: unknown, category: EmailConsentCategory): boolean {
  return readLegalMetadata(appMetadata).email_consents?.[category]?.granted === true;
}

/** Ścieżka bramki — poza grupą (dashboard), żeby nie zapętlić przekierowań. */
export const LEGAL_GATE_PATH = '/onboarding/zgody';
