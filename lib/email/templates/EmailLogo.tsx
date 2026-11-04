import { Img } from '@react-email/components';

import { siteUrl } from '@/lib/site';

/**
 * Logo FaktWay w nagłówku maili do użytkowników FaktWay (nie w mailach, które
 * klient wysyła swoim kontrahentom). PNG, bo Gmail i Outlook nie pokazują SVG;
 * plik 2x (280×62) dla ekranów retina, z docs/brand/logo/zrodla/aplikacja.py.
 */
export function EmailLogo() {
  return (
    <Img
      src={`${siteUrl()}/brand/faktway-logo-email.png`}
      width="140"
      height="31"
      alt="FaktWay"
      style={{ display: 'block', margin: '0 0 28px 0' }}
    />
  );
}
