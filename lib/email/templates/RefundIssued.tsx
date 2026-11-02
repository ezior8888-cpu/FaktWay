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

export interface RefundIssuedProps {
  tenantName: string;
  amountLabel: string;
  reason: string | null;
}

/**
 * Faza 25 Krok 5 — potwierdzenie refundu dla klienta.
 * Wysyłany po `issueRefundAction` w admin panelu (Faza 24 ext).
 */
export default function RefundIssued({
  tenantName,
  amountLabel,
  reason,
}: RefundIssuedProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>Zwrot przetworzony ✓</Heading>

          <Text style={textStyle}>
            Cześć {tenantName}, wystawiliśmy zwrot na kwotę{' '}
            <strong>{amountLabel}</strong>. Środki wrócą na metodę płatności,
            którą zapłaciłeś, w ciągu 5-10 dni roboczych (czas zależy od banku).
          </Text>

          {reason ? (
            <Section style={boxStyle}>
              <Text style={labelStyle}>Powód</Text>
              <Text style={reasonStyle}>{reason}</Text>
            </Section>
          ) : null}

          <Text style={textStyle}>
            Jeśli masz dodatkowe pytania, odpisz na ten email.
          </Text>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            FaktWay — faktury KSeF dla mikrofirm. Wiadomość automatyczna.
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
  color: '#10b981',
  fontSize: '24px',
  margin: '0 0 24px 0',
};
const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 16px 0',
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
const reasonStyle = {
  color: '#111827',
  fontSize: '14px',
  margin: '4px 0 0 0',
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
