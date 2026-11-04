import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';

/** An incomplete active-company profile must not create a second organization. */
export function SellerProfileBlock() {
  // P5: oprawa karty Finory; treść, link i rola `alert` bez zmian.
  return (
    <Card role="alert" className="max-w-2xl shadow-none">
      <CardContent className="space-y-4">
        <h1 className="text-xl font-semibold">Wystawianie faktury jest wstrzymane</h1>
        <p className="text-muted-foreground text-sm">
          Nie możemy potwierdzić pełnych danych sprzedawcy aktywnej firmy.
          Sprawdź nazwę, NIP i adres w ustawieniach. Jeśli dane są niepełne lub błędne,
          skontaktuj się z administratorem, aby poprawić profil istniejącej firmy.
        </p>
        <Link href="/settings" className="text-primary inline-block text-sm font-medium underline-offset-4 hover:underline">
          Sprawdź dane firmy
        </Link>
      </CardContent>
    </Card>
  );
}
