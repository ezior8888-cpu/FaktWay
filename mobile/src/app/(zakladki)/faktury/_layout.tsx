import { Stack } from 'expo-router';

import { useOpcjeGradientu, useOpcjeStosu, useOpcjeSzczegoluNaGradiencie } from '@/wyglad/naglowki';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/**
 * Stos zakładki Faktury: lista (Wystawione, Cykliczne, Po terminie), szczegół,
 * arkusze: nowa faktura (własny stos: rodzaj, formularz), faktura cykliczna,
 * przypomnienie o zapłacie, wysyłka e-mailem.
 */
export default function UkladFaktur() {
  const opcje = useOpcjeStosu();
  const gradient = useOpcjeGradientu();
  const szczegol = useOpcjeSzczegoluNaGradiencie();
  return (
    <Stack screenOptions={opcje}>
      <Stack.Screen name="index" options={{ title: 'Faktury', ...gradient }} />
      <Stack.Screen name="[id]" options={{ title: '', ...szczegol }} />
      <Stack.Screen name="nowa" options={{ presentation: 'modal', headerShown: false }} />
      <Stack.Screen name="cykliczna" options={{ presentation: 'modal', title: 'Faktura cykliczna' }} />
      <Stack.Screen name="przypomnienie" options={{ presentation: 'modal', title: 'Przypomnienie o zapłacie' }} />
      <Stack.Screen name="email" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true, title: 'Wyślij e-mailem' }} />
    </Stack>
  );
}
