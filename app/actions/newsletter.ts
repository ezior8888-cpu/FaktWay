'use server';

import { z } from 'zod';

import { getClientIp } from '@/lib/auth/get-client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Zapis na newsletter z formularzy publicznych (blog).
 *
 * NIEPODPIĘTY (przegląd prawny 22.10.2026) — formularz nie stoi na żadnym
 * ekranie. Przed podpięciem: potwierdzenie zapisu (double opt-in), zapis
 * wersji brzmienia zgody (art. 7 ust. 1 RODO), link wypisu w każdej
 * wiadomości. Pilnuje tego tests/unit/newsletter-wstrzymany.test.ts.
 *
 * Formularz jest dostępny bez logowania, więc ochrona przed spamem:
 *   1. Honeypot `website` — pole niewidoczne dla człowieka; bot je wypełnia,
 *      dostaje pozorny sukces i nic nie zapisujemy.
 *   2. Rate limit per-IP (5 zapisów / 10 min) — ten sam mechanizm co auth.
 *   3. Zapis przez admin client (tabela ma RLS deny-all — anon nie może
 *      czytać ani pisać bezpośrednio przez PostgREST).
 *
 * Duplikat e-maila = sukces (ignoreDuplicates) — celowo nie zdradzamy,
 * czy adres już jest w bazie (brak enumeracji subskrybentów).
 */

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Podaj poprawny adres e-mail.')
  .max(320, 'Adres e-mail jest za długi.');

export type NewsletterSubscribeResult =
  | { success: true }
  | { success: false; error: string };

export async function subscribeNewsletterAction(input: {
  email: string;
  /** Honeypot — u człowieka zawsze puste. */
  website?: string;
}): Promise<NewsletterSubscribeResult> {
  if (input.website && input.website.trim() !== '') {
    return { success: true };
  }

  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Podaj poprawny adres e-mail.',
    };
  }

  const ip = await getClientIp();
  const rl = await checkRateLimit({
    bucket: 'newsletter',
    identifier: ip,
    limit: 5,
    windowSeconds: 600,
  });
  if (!rl.allowed) {
    return {
      success: false,
      error: `Za dużo prób. Spróbuj ponownie za ${rl.retryAfter} s.`,
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('newsletter_subscribers')
    .upsert(
      { email: parsed.data, source: 'blog' },
      { onConflict: 'email', ignoreDuplicates: true },
    );

  if (error) {
    console.error('[newsletter] insert failed:', error.message);
    return {
      success: false,
      error: 'Nie udało się zapisać. Spróbuj ponownie za chwilę.',
    };
  }

  return { success: true };
}
