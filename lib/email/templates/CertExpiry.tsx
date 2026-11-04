import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Section,
  Text,
} from '@react-email/components';

import { EmailLogo } from './EmailLogo';

export interface CertExpiryProps {
  tenantName: string;
  daysRemaining: number;
  expiryDate: string;
}

export default function CertExpiry({
  tenantName,
  daysRemaining,
  expiryDate,
}: CertExpiryProps) {
  const urgent = daysRemaining <= 7;
  const accentColor = urgent ? '#dc2626' : '#f59e0b';
  const dayWord = daysRemaining === 1 ? 'dzień' : 'dni';

  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={{ ...headingStyle, color: accentColor }}>
            {urgent ? '⚠️ PILNE: ' : ''}
            Certyfikat KSeF wygasa za {daysRemaining} {dayWord}
          </Heading>

          <Text style={textStyle}>
            Certyfikat przypisany do firmy <strong>{tenantName}</strong> wygasa{' '}
            <strong>{formatDate(expiryDate)}</strong>.
          </Text>

          <Text style={textSmallStyle}>
            Po wygaśnięciu certyfikatu nie będziesz w stanie wysyłać faktur do
            KSeF. To oznacza paraliż sprzedaży — od 1 kwietnia 2026 r.
            fakturowanie elektroniczne jest OBOWIĄZKOWE dla wszystkich firm B2B.
          </Text>

          <Section style={tipBoxStyle}>
            <Text style={tipTextStyle}>
              <strong>Co zrobić teraz:</strong>
              <br />
              1. Zaloguj się do Aplikacji Podatnika KSeF
              <br />
              2. Wygeneruj nowy certyfikat (typ 1 — uwierzytelnienie)
              <br />
              3. Wgraj go w ustawieniach FaktWay
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pl-PL');
  } catch {
    return iso;
  }
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
  fontSize: '22px',
  margin: '0 0 24px 0',
};
const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
};
const textSmallStyle = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '22px',
};
const tipBoxStyle = {
  backgroundColor: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: '8px',
  padding: '16px',
  margin: '20px 0',
};
const tipTextStyle = {
  color: '#92400e',
  fontSize: '14px',
  lineHeight: '22px',
  margin: 0,
};
