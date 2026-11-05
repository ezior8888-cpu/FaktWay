import { Fragment } from 'react';

import type { BlikDisclosure } from '@/lib/billing/trial-payment';

interface BlikTermsProps {
  title: string;
  rows: ReadonlyArray<{ label: string; value: string }>;
  banks: BlikDisclosure['banks'];
  /** Treść zgody, gdy nie stoi pod spodem w polu wyboru (przy przycisku portalu). */
  consent?: string;
}

/**
 * Warunki BLIK-a cyklicznego przed kodem. Przy formularzu hostowanym przez Stripe
 * pokazuje je sprzedawca: kwota dziś, data pierwszego obciążenia, cykl, zgoda i banki
 * (docs.stripe.com/payments/blik/recurring-payments). Dotyczy to Checkout przy starcie
 * próby i portalu, w którym klient z subskrypcją może dodać BLIK później.
 */
export function BlikTerms({ title, rows, banks, consent }: BlikTermsProps) {
  return (
    <div className="text-muted-foreground flex flex-col gap-2 rounded-md border p-3 text-xs leading-relaxed">
      <p className="text-foreground text-sm font-medium">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(({ label, value }) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className="text-foreground font-medium">{value}</dd>
          </Fragment>
        ))}
      </dl>
      <p>
        BLIK bez ponownego kodu działa w bankach: {banks.join(', ')}. Masz konto w innym
        banku? Na stronie płatności wybierz kartę.
      </p>
      {consent ? <p>{consent}</p> : null}
    </div>
  );
}
