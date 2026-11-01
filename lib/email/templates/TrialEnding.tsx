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

export interface TrialEndingProps {
  appUrl: string;
  tenantName: string;
  daysRemaining: 14 | 7 | 3 | 1;
  /** Format `1 lipca 2026` — server-side render z toLocaleDateString. */
  trialEndDate: string;
  planLabel: string;
  monthlyPriceLabel: string;
}

/**
 * Faza 25 Krok 5 — trial countdown email dla 4 stages (14/7/3/1 dni).
 * Treść skaluje się dynamicznie z `daysRemaining` — żebyśmy nie utrzymywali
 * 4 osobnych komponentów z 80% wspólnego layoutu.
 */
export default function TrialEnding({
  appUrl,
  tenantName,
  daysRemaining,
  trialEndDate,
  planLabel,
  monthlyPriceLabel,
}: TrialEndingProps) {
  const isFinalDay = daysRemaining === 1;
  const accentColor = isFinalDay ? '#dc2626' : daysRemaining <= 3 ? '#f59e0b' : '#3b82f6';

  const headline = isFinalDay
    ? 'Twój trial kończy się jutro'
    : `Twój trial kończy się za ${daysRemaining} dni`;

  const intro = isFinalDay
    ? `Cześć ${tenantName}, jutro (${trialEndDate}) zakończy się 30-dniowy darmowy okres testowy FaktWay. Karta zostanie obciążona za ${planLabel}.`
    : `Cześć ${tenantName}, za ${daysRemaining} dni (${trialEndDate}) zakończy się Twój darmowy 30-dniowy trial. Karta zostanie obciążona za ${planLabel}.`;

  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={{ ...headingStyle, color: accentColor }}>
            {headline}
          </Heading>

          <Text style={textStyle}>{intro}</Text>

          <Section style={boxStyle}>
            <Text style={labelStyle}>Plan</Text>
            <Text style={valueStyle}>{planLabel}</Text>
            <Text style={{ ...labelStyle, marginTop: '12px' }}>Cena</Text>
            <Text style={valueStyle}>{monthlyPriceLabel}</Text>
          </Section>

          <Text style={textStyle}>
            Jeśli chcesz <strong>kontynuować</strong> — nie musisz nic robić.
            Karta zostanie automatycznie obciążona w dniu {trialEndDate}.
          </Text>

          <Text style={textStyle}>
            Jeśli chcesz <strong>anulować</strong> — kliknij poniżej i wybierz
            {' „Anuluj subskrypcję” '}w panelu Stripe. Zachowasz dostęp do końca
            trialu.
          </Text>

          <Button href={`${appUrl}/settings/billing`} style={{ ...buttonStyle, backgroundColor: accentColor }}>
            Zarządzaj subskrypcją
          </Button>

          <Hr style={hrStyle} />

          <Text style={footerStyle}>
            FaktWay, faktury KSeF dla mikrofirm. Ta wiadomość została wysłana
            automatycznie. Pytania? Odpowiedz na ten email.
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
const valueStyle = {
  color: '#111827',
  fontSize: '16px',
  margin: '4px 0 0 0',
  fontWeight: 600 as const,
};
const buttonStyle = {
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'inline-block',
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
