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

export interface InvoiceAcceptedProps {
  ksefNumber: string;
  invoiceId: string;
  appUrl: string;
}

export default function InvoiceAccepted({
  ksefNumber,
  invoiceId,
  appUrl,
}: InvoiceAcceptedProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>Faktura wysłana do KSeF ✓</Heading>

          <Text style={textStyle}>
            Twoja faktura została pomyślnie wysłana i zaakceptowana przez Krajowy
            System e-Faktur.
          </Text>

          <Section style={boxStyle}>
            <Text style={labelStyle}>Numer KSeF</Text>
            <Text style={valueStyle}>{ksefNumber}</Text>
          </Section>

          <Button href={`${appUrl}/invoices/${invoiceId}`} style={buttonStyle}>
            Zobacz szczegóły faktury
          </Button>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            Wiadomość automatyczna z systemu FaktWay. Nie odpowiadaj na nią.
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
  fontSize: '18px',
  fontFamily: 'Monaco, monospace',
  margin: '4px 0 0 0',
};
const buttonStyle = {
  backgroundColor: '#111827',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'inline-block',
};
const hrStyle = {
  borderColor: '#e5e7eb',
  margin: '32px 0 16px 0',
};
const footerStyle = {
  color: '#9ca3af',
  fontSize: '12px',
};
