import { Stack } from 'expo-router';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Koszty: wydatki i skrzynka KSeF, opis wydatku, dodawanie ze zdjęcia. */
export default function UkladKosztow() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Koszty', headerLargeTitle: true }} />
      <Stack.Screen name="[id]" options={{ title: '' }} />
      <Stack.Screen
        name="dodaj"
        options={{ presentation: 'formSheet', sheetAllowedDetents: [0.55, 1], sheetGrabberVisible: true, title: 'Dodaj wydatek' }}
      />
    </Stack>
  );
}
