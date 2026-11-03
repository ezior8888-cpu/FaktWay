'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { generateAccountantToken } from '@/lib/accountant/tokens';
import { logAudit } from '@/lib/audit/log';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { ActionAuthError, requireOwner } from '@/lib/supabase/auth-context';

const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  accessLevel: z.enum(['read_only', 'download']),
  validForDays: z.coerce.number().min(1).max(365),
});

export type CreateAccountantTokenResult =
  | { success: true; id: string; token: string; shareUrl: string }
  /** `mfaStepUp`: sesja po biometrii, konto ma 2FA. Formularz pokazuje przejście na ekran kodu. */
  | { success: false; error: string; mfaStepUp?: true };

export async function createAccountantTokenAction(
  input: z.infer<typeof createTokenSchema>
): Promise<CreateAccountantTokenResult> {
  const parsed = createTokenSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    return { success: false, error: msg || 'Niepoprawne dane' };
  }

  let ctx;
  try {
    ctx = await requireOwner();
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Brak uprawnień',
    };
  }
  const { supabase, tenantId, user } = ctx;

  // Link daje dostęp do faktur osobie z zewnątrz: sesja po biometrii potrzebuje kodu.
  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Wystawienie linku dla księgowej');
  if (stepUp) return stepUp;

  const { token, hash } = generateAccountantToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + parsed.data.validForDays);

  const { data: created, error } = await supabase
    .from('accountant_access')
    .insert({
      tenant_id: tenantId,
      token_hash: hash,
      accountant_name: parsed.data.name,
      accountant_email: parsed.data.email,
      access_level: parsed.data.accessLevel,
      expires_at: expiresAt.toISOString(),
      created_by_user_id: user.id,
    })
    .select('id')
    .single();

  if (error || !created) {
    return { success: false, error: error?.message ?? 'Błąd tworzenia zaproszenia' };
  }

  await logAudit({
    action: 'accountant.token_created',
    tenantId,
    userId: user.id,
    entityType: 'accountant_access',
    entityId: created.id,
    metadata: {
      accountantEmail: parsed.data.email,
      accessLevel: parsed.data.accessLevel,
      validForDays: parsed.data.validForDays,
    },
  });

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  const shareUrl = `${appUrl}/accountant/${encodeURIComponent(token)}`;

  revalidatePath('/settings/accountant');
  return { success: true, id: created.id, token, shareUrl };
}

export type RevokeAccountantTokenResult =
  | { success: true }
  | { success: false; error: string };

export async function revokeAccountantTokenAction(
  accessId: string
): Promise<RevokeAccountantTokenResult> {
  // Jak przy tworzeniu: właściciel aktywnej firmy po drugim kroku MFA.
  // Do 02.10 wystarczał `getUser()` (AUD-58); RLS i tak wpuszcza tylko
  // właściciela, ale błąd był wtedy „nie znaleziono wpisu”.
  let ctx: Awaited<ReturnType<typeof requireOwner>>;
  try {
    ctx = await requireOwner();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, user, tenantId } = ctx;

  const { data: row, error: selErr } = await supabase
    .from('accountant_access')
    .select('tenant_id')
    .eq('id', accessId)
    .maybeSingle();

  if (selErr) return { success: false, error: selErr.message };
  if (!row?.tenant_id || row.tenant_id !== tenantId) {
    return { success: false, error: 'Nie znaleziono wpisu lub brak uprawnień.' };
  }

  const { data: updated, error } = await supabase
    .from('accountant_access')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', accessId)
    .select('id');

  if (error) return { success: false, error: error.message };
  if (!updated?.length) {
    return { success: false, error: 'Nie udało się cofnąć dostępu.' };
  }

  await logAudit({
    action: 'accountant.token_revoked',
    tenantId: row.tenant_id,
    userId: user.id,
    entityType: 'accountant_access',
    entityId: accessId,
  });

  revalidatePath('/settings/accountant');
  return { success: true };
}
