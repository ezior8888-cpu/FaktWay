import { Stack } from 'expo-router';

/** Stos zakładki Faktury: lista, szczegół faktury, arkusz „Nowa faktura”. */
export default function UkladFaktur() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Faktury', headerLargeTitle: true }} />
      <Stack.Screen name="faktura/[id]" options={{ title: '' }} />
      <Stack.Screen name="nowa" options={{ presentation: 'modal', title: 'Nowa faktura' }} />
    </Stack>
  );
}
