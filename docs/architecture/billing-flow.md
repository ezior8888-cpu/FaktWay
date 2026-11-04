# Billing Flow — Stripe + self-invoicing

Lifecycle subskrypcji: od checkout do faktury VAT, którą **nasza apka** wystawia
sama sobie przez własny pipeline KSeF (meta-rekursja).

## Diagram

```mermaid
sequenceDiagram
    actor U as Użytkownik
    participant N as Next.js
    participant DB as Supabase
    participant S as Stripe
    participant I as Inngest
    participant K as KSeF (pipeline Fazy 23)

    U->>N: kliknij "Wypróbuj" na /pricing
    N->>S: createCheckoutSession (trial 30 dni)
    S-->>U: redirect Stripe Checkout
    U->>S: dane karty albo kod BLIK (po włączeniu STRIPE_BLIK_RECURRING)
    S-->>N: redirect /settings/billing?success

    Note over S,N: Reszta dzieje się przez webhooki

    S->>N: webhook checkout.session.completed
    N->>DB: idempotency check (stripe_webhook_events)
    N->>DB: UPSERT subscriptions, tenants.stripe_customer_id

    Note over S: 30 dni triala...

    S->>N: webhook invoice.payment_succeeded
    N->>DB: idempotency check
    N->>DB: INSERT stripe_payments
    N->>I: event "self-invoice/payment.succeeded"

    I->>DB: SELECT tenant + plan + kwota
    I->>K: event "invoice/submit.requested"
    Note over K: Nasza firma (FAKTFLOW_OPERATOR_TENANT_ID)<br/>jako sprzedawca wystawia FV<br/>klientowi przez ten sam pipeline KSeF

    K-->>DB: invoice + UPO (klient widzi w /invoices)
    I->>U: email faktury VAT (Resend)

    alt payment_failed
        S->>N: webhook invoice.payment_failed
        N->>I: event dunning
        I->>U: email "płatność nieudana" + retry schedule
    end

    alt user anuluje
        U->>N: /settings/billing → Customer Portal
        N->>S: redirect Stripe Portal
        S-->>N: webhook subscription.deleted (po końcu okresu)
        N->>DB: UPDATE subscriptions status=canceled
    end
```

## Klucze do zrozumienia

1. **Subscription PER-TENANT, nie per-user.** `tenants.stripe_customer_id` — cała firma płaci jeden plan.
2. **Trial 30 dni** ustawiony przez `subscription_data.trial_period_days: 30` w Checkout. Trial countdown emaile (Faza 25): T-14, T-7, T-3, T-1.
3. **Self-invoicing = my wystawiamy fakturę przez nasz własny pipeline KSeF (Fazy 23).** `FAKTFLOW_OPERATOR_TENANT_ID` env var = nasza firma. Klient dostaje prawdziwą fakturę VAT w `/invoices` jak każdą inną.
4. **Idempotency wszędzie** — `stripe_webhook_events` zapamiętuje `event.id`; każdy webhook re-delivery jest no-op. Bez tego Stripe by zdublował płatności przy retry.
5. **Dunning** = email retry schedule po nieudanej płatności. Stripe próbuje sam 4× przez 3 tygodnie; my dokładamy emaile (Faza 25).
6. **Customer Portal Stripe robi UI** — anulowanie, zmiana metody płatności, faktury historyczne. Nie reimplementujemy.
7. **BLIK cykliczny za przełącznikiem** `STRIPE_BLIK_RECURRING=on`: Checkout dostaje listę metod i wersję API na to jedno żądanie, faktura za abonament ma formę „mobilna” (FA(3): 7). Procedura: [`docs/runbooks/stripe-blik.md`](../runbooks/stripe-blik.md).

## Powiązany kod

- `app/api/stripe/webhook/route.ts` — webhook handler (signature verify, idempotency)
- `app/(dashboard)/settings/billing/` — UI subskrypcji + portal redirect
- `app/(dashboard)/settings/billing/actions.ts` — Server Actions
- `lib/inngest/jobs/self-invoice-payment.ts` — emisja FV po opłaconej płatności
- `lib/inngest/jobs/dunning-payment-failed.ts` — emaile po failed payment
- `lib/inngest/jobs/trial-countdown-emails.ts` — trial countdown
- Tabele: `subscriptions`, `stripe_payments`, `stripe_refunds`, `stripe_webhook_events`, `billing_notifications`

## Env vars (zob. [current_state.md](../../.claude/projects/-Users-mokryrys-dev-ksef-saas/memory/current_state.md))

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_BLIK_RECURRING`,
`FAKTFLOW_OPERATOR_TENANT_ID`, `FAKTFLOW_OPERATOR_BANK_ACCOUNT`.
