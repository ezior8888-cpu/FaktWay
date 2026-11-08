import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Section,
  Text,
} from '@react-email/components';

import { EmailLogo } from './EmailLogo';

export interface AccountDeletionConfirmationProps {
  tenantName: string;
  /** Format: 'DD MMMM YYYY' — kiedy konto zostanie trwale usunięte. */
  hardDeleteDate: string;
  /** Email kontaktowy gdyby user chciał odzyskać konto. */
  supportEmail: string;
}

/**
 * Faza 26 — RODO compliance. Wysyłany po `admin.user.deleted` lub po
 * user-initiated account deletion. Informuje o retention period (30 dni)
 * + jak odzyskać konto.
 *
 * Kategoria: transactional (RODO wymaga potwierdzenia żądania usunięcia).
 */
export default function AccountDeletionConfirmation({
  tenantName,
  hardDeleteDate,
  supportEmail,
}: AccountDeletionConfirmationProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>
            Potwierdzenie usunięcia konta
          </Heading>

          <Text style={textStyle}>
            Cześć {tenantName}, otrzymaliśmy żądanie usunięcia Twojego konta
            FaktWay. Procedura RODO została uruchomiona.
          </Text>

          <Section style={boxStyle}>
            <Text style={labelStyle}>Twardy delete</Text>
            <Text style={valueStyle}>{hardDeleteDate}</Text>
            <Text
              style={{
                ...labelStyle,
                marginTop: '12px',
              }}
            >
              Status
            </Text>
            <Text style={valueStyle}>Soft-delete (30 dni retencji)</Text>
          </Section>

          <Text style={textStyle}>
            Co się stało:
          </Text>

          <Text style={listItemStyle}>
            • Twoja organizacja została oznaczona jako usunięta. Nie zobaczysz
            jej już w panelu.
          </Text>
          <Text style={listItemStyle}>
            • Po 30 dniach (do {hardDeleteDate}) wszystkie Twoje dane zostaną
            trwale skasowane z naszych baz danych i kopii zapasowych.
          </Text>
          <Text style={listItemStyle}>
            • Faktury i KSeF wpisy podlegające 10-letniej retencji prawnej
            (RODO art. 17 ust. 3 lit. b) zostaną zachowane wyłącznie w
            niezbędnym zakresie podatkowym i prawnym.
          </Text>

          <Hr style={hrStyle} />

          <Heading as="h2" style={subheadingStyle}>
            Pomyłka? Możesz cofnąć
          </Heading>
          <Text style={textStyle}>
            Jeśli nie chciałeś usunąć konta, napisz do nas w ciągu 30 dni:
          </Text>
          <Text style={textStyle}>
            <strong>{supportEmail}</strong>
          </Text>
          <Text style={textStyle}>
            Po 30 dniach przywrócenie konta będzie technicznie niemożliwe.
          </Text>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            FaktWay, faktury KSeF dla mikrofirm. Wiadomość automatyczna.
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
const headingStyle = {
  color: '#111827',
  fontSize: '24px',
  margin: '0 0 24px 0',
};
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
const listItemStyle = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 8px 0',
  paddingLeft: '8px',
};
const boxStyle = {
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  margin: '24px 0',
};
const labelStyle = {
  color: '#6b7280',
  fontSize: '12px',
  textTransform: 'uppercase' as const,
  margin: 0,
};
const valueStyle = {
  color: '#111827',
  fontSize: '16px',
  margin: '4px 0 0 0',
  fontWeight: 600 as const,
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
