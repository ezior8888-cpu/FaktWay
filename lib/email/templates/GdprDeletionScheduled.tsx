import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Section,
  Text,
} from '@react-email/components';

import { EmailLogo } from './EmailLogo';

export interface GdprDeletionScheduledProps {
  userEmail: string;
  /** Format 'DD MMMM YYYY' — moment hard delete. */
  scheduledFor: string;
  /** Pełen URL z `?token=...` do anulowania. */
  cancelUrl: string;
  supportEmail: string;
}

/**
 * Faza 28 Krok 7 — wysyłany natychmiast po utworzeniu GDPR deletion request.
 * 14-dniowy cooling-off — link cancel jest jedyną drogą do anulowania
 * (po wygaśnięciu cooling-off delete jest nieodwracalny).
 *
 * Kategoria: transactional (RODO compliance + safety).
 */
export default function GdprDeletionScheduled({
  userEmail,
  scheduledFor,
  cancelUrl,
  supportEmail,
}: GdprDeletionScheduledProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>
            Żądanie usunięcia konta — RODO
          </Heading>

          <Text style={textStyle}>
            Otrzymaliśmy Twoje żądanie usunięcia konta <strong>{userEmail}</strong>{' '}
            z FaktWay zgodnie z art. 17 RODO (prawo do bycia zapomnianym).
          </Text>

          <Section style={boxStyle}>
            <Text style={labelStyle}>Data trwałego usunięcia</Text>
            <Text style={valueStyle}>{scheduledFor}</Text>
            <Text style={{ ...labelStyle, marginTop: '12px' }}>Status</Text>
            <Text style={valueStyle}>Pending (14 dni cooling-off)</Text>
          </Section>

          <Text style={textStyle}>Co się stanie:</Text>
          <Text style={listItemStyle}>
            • Przez kolejne 14 dni możesz cofnąć decyzję — kliknij link poniżej.
          </Text>
          <Text style={listItemStyle}>
            • Po {scheduledFor} Twoje konto, sesje, kody ratunkowe 2FA i
            ustawienia zostaną trwale usunięte z naszych baz.
          </Text>
          <Text style={listItemStyle}>
            • Logi audytowe zostaną zanonimizowane (zachowujemy zdarzenia
            zgodnie z compliance, ale bez PII).
          </Text>
          <Text style={listItemStyle}>
            • Faktury podlegające 10-letniej retencji prawnej (RODO art. 17
            ust. 3 lit. b) zostaną zachowane w organizacjach, gdzie zostały
            wystawione — to obowiązek prawny firm, nie Twoja decyzja.
          </Text>

          <Hr style={hrStyle} />

          <Heading as="h2" style={subheadingStyle}>
            Pomyłka? Cofnij teraz
          </Heading>
          <Text style={textStyle}>
            Jeśli to nie Ty zleciłeś usunięcie albo zmieniłeś zdanie:
          </Text>
          <Text style={textStyle}>
            <Link href={cancelUrl} style={buttonStyle}>
              Anuluj usunięcie konta
            </Link>
          </Text>
          <Text style={smallStyle}>
            Link działa do {scheduledFor}. Po tej dacie cofnięcie nie będzie
            technicznie możliwe.
          </Text>

          <Hr style={hrStyle} />

          <Text style={textStyle}>
            Masz pytania? Napisz: <strong>{supportEmail}</strong>
          </Text>
          <Text style={footerStyle}>
            FaktWay, faktury KSeF dla mikrofirm. Wiadomość transakcyjna.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: '#f6f6f6',
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};
const containerStyle = {
  backgroundColor: '#ffffff',
  maxWidth: '600px',
  margin: '40px auto',
  padding: '40px',
  borderRadius: '8px',
};
const headingStyle = { color: '#111827', fontSize: '24px', margin: '0 0 24px 0' };
const subheadingStyle = {
  color: '#111827',
  fontSize: '18px',
  margin: '0 0 12px 0',
};
const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 16px 0',
};
const smallStyle = {
  color: '#6b7280',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '8px 0 16px 0',
};
const listItemStyle = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 8px 0',
  paddingLeft: '8px',
};
const boxStyle = {
  backgroundColor: '#fef3c7',
  border: '1px solid #fcd34d',
  borderRadius: '8px',
  padding: '20px',
  margin: '24px 0',
};
const labelStyle = {
  color: '#92400e',
  fontSize: '12px',
  textTransform: 'uppercase' as const,
  margin: 0,
};
const valueStyle = {
  color: '#451a03',
  fontSize: '16px',
  margin: '4px 0 0 0',
  fontWeight: 600 as const,
};
const buttonStyle = {
  display: 'inline-block',
  padding: '12px 20px',
  backgroundColor: '#dc2626',
  color: '#ffffff',
  borderRadius: '6px',
  textDecoration: 'none',
  fontWeight: 600 as const,
};
const hrStyle = { borderColor: '#e5e7eb', margin: '32px 0 16px 0' };
const footerStyle = { color: '#9ca3af', fontSize: '12px' };
