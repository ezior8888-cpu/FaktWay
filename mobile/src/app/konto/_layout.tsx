import { Stack } from 'expo-router';

export default function UkladKonta() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Konto', headerLargeTitle: true }} />
    </Stack>
  );
}
