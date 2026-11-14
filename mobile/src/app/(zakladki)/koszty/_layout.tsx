import { Stack } from 'expo-router';

import { useOpcjeGradientu, useOpcjeStosu, useOpcjeSzczegoluNaGradiencie } from '@/wyglad/naglowki';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Koszty: wydatki i skrzynka KSeF, opis wydatku, dodawanie ze zdjęcia. */
export default function UkladKosztow() {
  const opcje = useOpcjeStosu();
  const gradient = useOpcjeGradientu();
  const szczegol = useOpcjeSzczegoluNaGradiencie();
  return (
    <Stack screenOptions={opcje}>
      <Stack.Screen name="index" options={{ title: 'Koszty', ...gradient }} />
      <Stack.Screen name="[id]" options={{ title: '', ...szczegol }} />
      <Stack.Screen name="ksef/[id]" options={{ title: '', ...szczegol }} />
      <Stack.Screen
        name="dodaj"
        options={{ presentation: 'formSheet', sheetAllowedDetents: [0.55, 1], sheetGrabberVisible: true, title: 'Dodaj wydatek' }}
      />
    </Stack>
  );
}
