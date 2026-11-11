# OCR Flow — Paragon → wpis KPiR

Lifecycle skanowania paragonu: od zdjęcia z telefonu do gotowego wpisu w księdze
przychodów i rozchodów (KPiR).

## Diagram

```mermaid
sequenceDiagram
    actor U as Użytkownik (telefon)
    participant SW as PWA / Web Share
    participant N as Next.js (route)
    participant DB as Supabase
    participant I as Inngest
    participant C as Anthropic Claude
    participant CR as Categorization rules

    U->>SW: "Udostępnij" zdjęcie do FaktFlow
    SW->>N: POST /share-target (multipart photo)
    N->>DB: INSERT ocr_jobs (status=pending)
    N->>I: event "ocr/process-photo" {ocrJobId, tenantId}
    N-->>U: 303 redirect /expenses?ocr_pending=<jobId>

    Note over I: concurrency: limit 5 globalnie

    I->>DB: UPDATE ocr_jobs status=processing
    I->>C: vision: rozpoznaj paragon (model: Sonnet)
    C-->>I: {seller, items, total, vat, date, ...}

    I->>CR: dopasuj kategorię KPiR (rules per tenant + globalne)
    CR-->>I: kpir_column + auto_categorized=true|false

    I->>DB: INSERT expenses + UPDATE ocr_jobs status=done
    I->>DB: jeśli auto: INSERT kpir_entries

    loop polling client-side
        U->>N: GET /expenses?ocr_pending=<jobId>
        N->>DB: SELECT ocr_jobs status
        N-->>U: HTML z aktualnym statusem
    end

    alt user akceptuje
        U->>N: review + edit → reviewExpenseAction
        N->>DB: UPDATE expenses is_reviewed=true
    else user odrzuca
        U->>N: deleteExpenseAction
        N->>DB: DELETE expense + ocr_job
    end
```

## Klucze do zrozumienia

1. **Web Share Target = PWA magic.** Telefon traktuje FaktFlow jak natywną apkę: "Udostępnij" w galerii pokazuje FaktFlow. Stąd `app/share-target/route.ts` (real route, nie Server Action).
2. **Status przez polling, nie SSE.** Decyzja udokumentowana w [performance-budget](../performance-budget.md) §8 — Vercel źle znosi long-lived connections.
3. **Globalne concurrency 5** — Claude vision ma limity rate; nie chcemy zalać go 100 zdjęciami naraz. Stress-test (`load:stress:ocr`) sprawdza zachowanie pod 100 concurrent uploaderami.
4. **Categorization rules są dwupoziomowe** — per-tenant (user własne) + globalne (`kpir_global_rules`). Auto-kategoryzacja TYLKO gdy match jest pewny; inaczej user review.
5. **Retencja zdjęć** — oryginalne zdjęcie paragonu jest w `expenses.image_path` (R2), retencja 10 lat (RODO/prawo dokumenty KPiR).

## Powiązany kod

- `app/share-target/route.ts` — udostępnienie z telefonu (multipart `photo`)
- `app/api/uploads/expense/route.ts` — „Dodaj wydatek” w panelu (multipart `photo`); obie trasy poza proxy, bramka `lib/uploads/server.ts`, przyjęcie pliku `lib/expenses/accept-upload.ts` (plan skalowania, sesja 31: PDF do 10 MB, zdjęcie do 7 MB)
- `app/actions/expenses.ts` — `getOcrJobStatusAction`, `reviewExpenseAction`, `deleteExpenseAction`
- `lib/inngest/jobs/process-ocr.ts` — główny job (concurrency: 5, retries: 2)
- `lib/inngest/jobs/auto-categorize-inbox.ts` — auto-kategoryzacja
- Tabele: `ocr_jobs`, `expenses`, `kpir_entries`, `categorization_rules`, `kpir_global_rules`

## Tryby uploadu

| Tryb | Wejście | Endpoint |
|---|---|---|
| PWA Share Target | "Udostępnij" z galerii | `POST /share-target` |
| Aparat / wybór pliku | „Dodaj wydatek” (Koszty, plus dolnego paska) | `POST /api/uploads/expense` |
| Email forwarding | (planowane post-launch) | — |
