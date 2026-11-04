/**
 * Trasy `(auth)/*` składają układ same: każda strona renderuje
 * `AuthSplitLayout` (plan Finora P15), bo prawa połowa ma na każdym ekranie
 * inny nagłówek — tak jak `src/views/pages/auth/*` w Finorze.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
