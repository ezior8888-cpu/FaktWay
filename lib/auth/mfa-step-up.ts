import { safeRedirectPath } from '@/lib/auth/safe-redirect';

/**
 * Przejście z operacji wrażliwej na ekran kodu i z powrotem. Stan
 * `challenge_required` jest w panelu osiągalny dopiero przez logowanie biometrią
 * (`lib/auth/panel-mfa.ts`), więc każda odmowa „potrzebny kod” prowadzi tutaj.
 * `potwierdzenie=1` każe ekranowi kodu powiedzieć, dlaczego o niego pyta.
 * Bez `server-only`: linki budują też komponenty klienckie.
 */
export function mfaStepUpHref(returnTo: string): string {
  return '/login/two-factor?' + new URLSearchParams({
    redirect: safeRedirectPath(returnTo),
    potwierdzenie: '1',
  });
}
