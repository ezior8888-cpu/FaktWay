import type { Metadata } from 'next';

import { LegalDocumentView } from '@/components/legal/legal-page';
import { REGULAMIN } from '@/lib/legal/documents';

// Treść jest stała między wdrożeniami — strona może być w pełni statyczna.
export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'Regulamin',
  description: 'Regulamin świadczenia usług FaktWay: zakres usług, opłaty, KSeF, odpowiedzialność, reklamacje i odstąpienie od umowy.',
};

export default function TermsPage() {
  return <LegalDocumentView doc={REGULAMIN} />;
}
