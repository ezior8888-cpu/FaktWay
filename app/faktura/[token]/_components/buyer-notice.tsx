import { Card, CardContent } from '@/components/ui/card';

/**
 * Komunikat strony nabywcy zamiast faktury (link nie działa, limit prób,
 * chwilowa niedostępność): co się stało i co zrobić, bez żadnych danych faktury.
 */
export function BuyerNotice({ title, text }: { title: string; text: string }) {
  return (
    <main className="bg-background text-foreground min-h-screen p-4 lg:p-8">
      <Card className="mx-auto max-w-lg shadow-none">
        <CardContent className="space-y-2 py-6 text-center">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm">{text}</p>
        </CardContent>
      </Card>
    </main>
  );
}
