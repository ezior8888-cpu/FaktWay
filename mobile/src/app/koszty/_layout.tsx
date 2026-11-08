import { Stack } from 'expo-router';

export default function UkladKosztow() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Koszty', headerLargeTitle: true }} />
    </Stack>
  );
}
