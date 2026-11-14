import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components';

import { EmailLogo } from './EmailLogo';

/**
 * Przypomnienie o terminie rozliczenia z modułu księgowości (plan księgowości
 * JDG, K5). Treść składa `lib/ksiegowosc/przypomnienia.ts`; bez trybu
 * rozkazującego i bez porad (D8), z podpisem kwot (NZ-TRESC-02), więc szablon
 * go nie powtarza.
 */
export interface TerminRozliczeniaProps {
  tytul: string;
  tresc: string;
  /** Pełny adres strony „Ten miesiąc” za ten miesiąc. */
  adres: string;
}

export default function TerminRozliczenia({ tytul, tresc, adres }: TerminRozliczeniaProps) {
  return (
    <Html lang="pl">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <EmailLogo />
          <Heading style={headingStyle}>{tytul}</Heading>
          <Text style={textStyle}>{tresc}</Text>
          <Text style={textSmallStyle}>
            Dane do przelewu i oznaczanie zapłaty są w FaktWay, w zakładce „Ten miesiąc”. Gdy zapłata jest tam oznaczona,
            przypomnienia o tym rozliczeniu ustają.
          </Text>
          <Button href={adres} style={buttonStyle}>
            „Ten miesiąc” w FaktWay
          </Button>
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
const buttonStyle = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '12px 20px',
  fontSize: '14px',
  textDecoration: 'none',
};
