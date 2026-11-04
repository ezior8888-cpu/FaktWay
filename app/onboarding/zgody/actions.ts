'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import { recordTermsAcceptance } from '@/lib/legal/record';
import { safeNextPath } from '@/lib/legal/safe-next';

/**
 * Akceptacja dokumentów w bramce /onboarding/zgody (konta z Google, konta
 * sprzed wprowadzenia dokumentów, zmiana wersji regulaminu).
 */
export async function acceptTermsAction(formData: FormData): Promise<void> {
  const context = await getVerifiedUserContext();
  if (!context.ok) redirect('/login?redirect=/onboarding/zgody');

  const next = safeNextPath(formData.get('next'));
  if (formData.get('terms') !== 'on') {
    redirect(`/onboarding/zgody?error=terms_required&next=${encodeURIComponent(next)}`);
  }

  const result = await recordTermsAcceptance({
    userId: context.user.id,
    method: 'gate',
    marketingConsent: formData.get('marketing') === 'on',
  }).catch(() => ({ ok: false }));
  if (!result.ok) {
    redirect(`/onboarding/zgody?error=save_failed&next=${encodeURIComponent(next)}`);
  }

  revalidatePath('/', 'layout');
  redirect(next);
}
