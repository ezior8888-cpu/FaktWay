import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Section,
  Text,
} from '@react-email/components';

import { EmailLogo } from './EmailLogo';

export interface MagicImportCompletedProps {
  appUrl: string;
  tenantName: string;
  invoicesImported: number;
  contractorsImported: number;
  productsImported: number;
  /** Liczba błędów które user powinien przejrzeć. */
  warningsCount?: number;
}

/**
 * Faza 26 — Magic Import done email (kategoria `product_updates`).
 * Wysyłany przez `magic-import-ksef.ts` job po zakończeniu importu.
 *
 * UX cel: user widzi konkretne liczby → wow effect → otwiera apkę.
 */
export default function MagicImportCompleted({
  appUrl,
  tenantName,
  invoicesImported,
  contractorsImported,
  productsImported,
  warningsCount,
}: MagicImportCompletedProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>
            Twoja historia jest gotowa ✨
          </Heading>

          <Text style={textStyle}>
            Cześć {tenantName}, ściągnęliśmy Twoje dane z KSeF i innych źródeł.
            Wszystko już czeka w aplikacji.
          </Text>

          <Section style={statsRowStyle}>
            <StatBox label="Faktur" value={invoicesImported.toLocaleString('pl-PL')} />
            <StatBox label="Kontrahentów" value={contractorsImported.toLocaleString('pl-PL')} />
            <StatBox label="Produktów" value={productsImported.toLocaleString('pl-PL')} />
          </Section>

          <Button href={`${appUrl}/invoices`} style={buttonStyle}>
            Zobacz faktury
          </Button>

          {warningsCount && warningsCount > 0 ? (
            <>
              <Hr style={hrStyle} />
              <Text style={warningStyle}>
                Uwaga: {warningsCount}{' '}
                {warningsCount === 1
                  ? 'wpis wymaga'
                  : warningsCount < 5
                    ? 'wpisy wymagają'
                    : 'wpisów wymaga'}{' '}
                {'ręcznej weryfikacji. Zajrzyj do panelu i sprawdź zakładkę „Wymagane uzupełnienia”.'}
              </Text>
            </>
          ) : null}

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            FaktWay, faktury KSeF dla mikrofirm. Wiadomość automatyczna.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={statBoxStyle}>
      <Text style={statValueStyle}>{value}</Text>
      <Text style={statLabelStyle}>{label}</Text>
    </div>
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
const statsRowStyle = {
  display: 'flex' as const,
  gap: '12px',
  margin: '24px 0',
};
const statBoxStyle = {
  flex: 1,
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '16px',
  textAlign: 'center' as const,
};
const statValueStyle = {
  color: '#111827',
  fontSize: '28px',
  fontWeight: 700 as const,
  margin: 0,
};
const statLabelStyle = {
  color: '#6b7280',
  fontSize: '12px',
  textTransform: 'uppercase' as const,
  margin: '4px 0 0 0',
};
const buttonStyle = {
  backgroundColor: '#10b981',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'inline-block',
  fontWeight: 600 as const,
};
const warningStyle = {
  color: '#92400e',
  backgroundColor: '#fef3c7',
  border: '1px solid #fde68a',
  borderRadius: '8px',
  padding: '12px 16px',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '16px 0',
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
