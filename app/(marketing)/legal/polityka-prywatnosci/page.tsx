import type { Metadata } from 'next';

import { LegalDocumentView } from '@/components/legal/legal-page';
import { POLITYKA_PRYWATNOSCI } from '@/lib/legal/documents';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'Polityka prywatności',
  description: 'Jak FaktWay przetwarza dane osobowe: cele, podstawy prawne, odbiorcy, okresy przechowywania i Twoje prawa.',
};

export default function PrivacyPage() {
  return <LegalDocumentView doc={POLITYKA_PRYWATNOSCI} />;
}
