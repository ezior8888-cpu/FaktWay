'use server';

import { LOGO_EDIT_ROLES, LOGO_ROLE_MESSAGE, removeCompanyLogo } from '@/lib/invoices/logo-firmy';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type DeleteCompanyLogoResult = { success: true } | { success: false; error: string };

/**
 * Usunięcie logo firmy z Ustawień → Firma (plan kompletnej aplikacji, krok
 * 2.2, część 1). Tylko właściciel i administrator, jak dane firmy; plik
 * znika z magazynu przed wskaźnikiem w bazie, zmiana trafia do audytu
 * (`lib/invoices/logo-firmy.ts`). Wgranie idzie trasą `/api/uploads/logo`
 * (Server Action przyjmuje najwyżej 1 MiB ciała).
 */
export async function deleteCompanyLogoAction(): Promise<DeleteCompanyLogoResult> {
  let ctx;
  try {
    ctx = await requireOrgRole([...LOGO_EDIT_ROLES]);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message === 'Niewystarczające uprawnienia' ? LOGO_ROLE_MESSAGE : e.message };
    }
    throw e;
  }
  return removeCompanyLogo(ctx);
}
