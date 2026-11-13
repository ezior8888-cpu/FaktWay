import { Stack } from 'expo-router';

import { useOpcjeGradientu, useOpcjeStosu } from '@/wyglad/naglowki';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Księgowość: Ten miesiąc, KPiR, Ewidencja, VAT, Eksport, Ustawienia podatkowe. */
export default function UkladKsiegowosci() {
  const opcje = useOpcjeStosu();
  const gradient = useOpcjeGradientu();
  return (
    <Stack screenOptions={opcje}>
      <Stack.Screen name="index" options={{ title: 'Księgowość', ...gradient }} />
      <Stack.Screen name="kpir" options={{ title: 'KPiR' }} />
      <Stack.Screen name="ewidencja" options={{ title: 'Ewidencja' }} />
      <Stack.Screen name="vat" options={{ title: 'VAT' }} />
      <Stack.Screen name="eksport" options={{ title: 'Eksport' }} />
      <Stack.Screen name="ustawienia-podatkowe" options={{ title: 'Ustawienia podatkowe' }} />
    </Stack>
  );
}
