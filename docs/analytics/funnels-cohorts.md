# Konfiguracja PostHog (Faza 31)

Kod wysyła eventy. Resztę (funnele, cohorty, dashboardy) konfigurujesz w
PostHog UI — to nie jest kod, tylko ustawienia projektu. Ten dokument
mówi co kliknąć i w jakiej kolejności.

---

## 1. Setup projektu

1. **eu.posthog.com** → Project Settings → Region **EU** (zgodność z Supabase/R2).
2. Skopiuj **Project API Key** → `NEXT_PUBLIC_POSTHOG_KEY` w Vercel.
3. Host: `https://eu.i.posthog.com` → `NEXT_PUBLIC_POSTHOG_HOST`.
4. **Personal API Key** (Settings → Personal API Keys → Create) → `POSTHOG_PERSONAL_API_KEY` jeśli będziesz używał PostHog API (opcjonalne, my zbieramy metryki z DB).

## 2. Group analytics — typ "tenant"

PostHog → Data Management → Groups → **Create group type**:
- Type name: `tenant`
- Group key: `tenant_id`

Bez tego eventy server-side wysyłane z `distinctId = tenantId` nie utworzą
osobnego widoku organizacji.

## 3. Kluczowe funnele

Insights → New insight → Funnels. Skopiuj poniższe konfiguracje:

### Acquisition funnel (Visitor → Paying)

```
Step 1: page_view (URL contains /pricing OR /vs/)
Step 2: signup_started
Step 3: signup_completed
Step 4: onboarding_completed
Step 5: payment_succeeded
```

Konwersja per-źródło: breakdown po `source` albo właściwości osoby
`first_touch_channel`. Lejek główny krok po kroku: [lejek-faktway.md](lejek-faktway.md).

### Activation funnel (24h post-signup)

```
Step 1: signup_completed
Step 2: ksef_configured     (w 24h)
Step 3: first_invoice_sent  (w 24h)
```

Każdy step który spada poniżej 50% to sygnał do poprawy onboardingu.

### Invoice funnel (KSeF reliability)

```
Step 1: invoice_created
Step 2: invoice_sent
Step 3: invoice_accepted
```

Drop-off między 2 i 3 = problem z walidacją / KSeF errors.

## 4. Cohort retention

Insights → New insight → **Retention**:
- Cohortizing event: `signup_completed`
- Retention event: `invoice_sent`
- Period: weekly, 12 weeks back

Cel: > 40% Week-4 retention dla zwrotności inwestycji w marketing.

## 5. Cohorty (Cohorts)

Data Management → Cohorts. Stwórz:

- **Activated** — userzy z `first_invoice_sent`
- **Paying** — userzy z `payment_succeeded` w ostatnich 30 dni
- **At risk** — Paying ale brak `invoice_sent` w ostatnich 14 dni
- **Power users** — ≥ 20 `invoice_sent` w ostatnim miesiącu

## 6. Dashboardy

Dashboards → New. Sugerowane:

### "Daily Pulse" (codziennie sprawdzasz rano)
- KPI: signups 24h
- KPI: invoices_accepted 24h
- KPI: MRR (oblicz z `subscriptions` w PostHog Insights → SQL)
- Trend: signups per day, 30d
- Trend: churn per week, 12w

### "Onboarding health"
- Funnel: Activation (z punktu 3)
- Trend: time to first invoice
- Cohort: weekly cohorts × first_invoice_sent rate

### "Support quality"
- Trend: support_chat_started per day
- Pie chart: support_chat by category
- KPI: % escalated
- KPI: CSAT positive rate (z `support_conversations.csat_positive`)

## 7. A/B experiments

Feature Flags → New feature flag → **Multivariate** dla A/B/n.
- Key: `signup-cta-copy` (dowolna nazwa)
- Variants: `control`, `variant-a`, `variant-b` z procentami
- Release conditions: 100% (lub mniej, gradual)

W kodzie: `useExperiment('signup-cta-copy')` (client) lub
`getExperimentVariant(distinctId, 'signup-cta-copy')` (server).

PostHog auto-tracks `$feature_flag_called` → konwersja eksperymentu w
zakładce **Experiments** (osobna od Feature Flags).

## 8. Session replay — co oglądać

Replay → Filter:
- **Frustrated sessions** — high rage clicks / dead clicks
- **Error sessions** — sesje z `$exception` (Sentry integration)
- **Funnel drop-off** — sesje które wypadły między signup_completed a first_invoice_sent

Maskowanie jest aktywne — nigdzie nie zobaczysz NIP / kwot. Jeśli czegoś
brakuje w maskowaniu, dodaj atrybut `data-ph-mask` do elementu w kodzie.

## 9. Slack daily digest

`dailyAnalyticsDigestJob` (Inngest cron 06:00 PL) wysyła podsumowanie
na Slack `#metrics` z naszej DB. Niezależne od PostHog — działa nawet
gdyby PostHog padł. Konfiguracja webhooka: `SLACK_WEBHOOK_METRICS` env.

## 10. Zgoda RODO

Client tracking startuje dopiero po opt-in. Server eventy też: `trackServer`
sprawdza `users.analytics_consent`, a zdarzenia firmy idą pod zgodą najstarszego
aktywnego właściciela. Szczegóły: [lejek-faktway.md](lejek-faktway.md).
