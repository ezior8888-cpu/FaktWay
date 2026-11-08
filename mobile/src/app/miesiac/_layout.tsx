import { Stack } from 'expo-router';

export default function UkladMiesiaca() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Ten miesiąc', headerLargeTitle: true }} />
    </Stack>
  );
}
