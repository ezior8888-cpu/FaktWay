This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Ten projekt używa **pnpm** (`pnpm-lock.yaml`). Instalacja zależności:

```bash
pnpm install
```

Nie uruchamiaj `npm install` w katalogu głównym — npm nie obsługuje tego lockfile’a; przy globalnym `.npmrc` z opcjami pnpm (np. `store-dir`) npm bywa zgłaszany z błędami lub ostrzeżeniami.

Lokalna baza (Supabase w Dockerze, migracje z repo, konto `dev@faktway.test`).
Pierwszy raz potrzebny jest Docker: `brew install colima docker`.

```bash
pnpm db:local
```

Skrypt ustawia `.env.local` na lokalną bazę. Ma też `status`, `stop` i `reset`
(kasuje lokalne dane) — opis w `scripts/dev/baza-lokalna.sh`.

Baza i serwer jedną komendą (np. po restarcie Maca): `pnpm dev:local`.

Serwer developerski:

```bash
pnpm dev
```

Otwórz [http://localhost:3000](http://localhost:3000) w przeglądarce.

Edycja zaczyna się od `app/page.tsx` — strona odświeża się przy zapisie.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
