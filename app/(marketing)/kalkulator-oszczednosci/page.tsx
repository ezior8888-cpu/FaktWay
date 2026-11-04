import type { Metadata } from 'next';

import { SavingsCalculatorPreview } from '@/components/marketing/savings-calculator-preview';
import { Reveal } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { Container } from '@/components/site/ui';

// Faza 22: kalkulator pełni interaktywny (state w komponencie), ale shell strony
// statyczny — cache na godzinę żeby SEO crawler dostawał konsystentny page.
export const revalidate = 3600;

// Końcówkę „| FaktWay” dopisuje szablon tytułu z layoutu.
export const metadata: Metadata = {
  title: 'Kalkulator oszczędności: sprawdź, ile zaoszczędzisz',
  description:
    'Oblicz ile godzin i pieniędzy zaoszczędzisz z podpowiedzią kolumny KPiR i odczytem faktur ze zdjęcia. Bezpłatny kalkulator dla mikrofirm i freelancerów.',
};

// Kafle „80% mniej czasu” i „11 dni średniego DSO z Wkurzaczem” usunięte
// 23.10.2026: nie mamy pomiarów, które by je potwierdzały (to samo „~11 dni”
// przegląd z 15.10.2026 usunął z bloga). Założenia kalkulatora są w jego
// stopce.

export default function CalculatorPage() {
  return (
    <>
      <PageHero
        // Twarda spacja: „w” nie może zostać samo na końcu linii.
        title={'Sprawdź, ile zaoszczędzisz w ciągu roku'}
        lead="Przesuń suwaki, aby dopasować do swojej działalności."
      />

      <div className="pb-20 sm:pb-28">
        <Container className="max-w-5xl">
          <Reveal onLoad delay={0.3} y={40}>
            <SavingsCalculatorPreview />
          </Reveal>

        </Container>
      </div>
    </>
  );
}
