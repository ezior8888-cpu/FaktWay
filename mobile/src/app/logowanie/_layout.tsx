import { Redirect, Stack } from 'expo-router';

import { useSesja } from '@/stan/sesja';
import { useKolory } from '@/wyglad/kolory';
import { czcionka } from '@/wyglad/typografia';

/**
 * Ekran logowania zawsze pod kodem 2FA, także gdy API poprosi o kod w trakcie
 * sesji (`wymagajKodu`, M7) i aplikacja przejdzie prosto na `/logowanie/kod`:
 * „wstecz” wraca wtedy do logowania i kończy krok 2FA.
 */
export const unstable_settings = { anchor: 'index' };

/**
 * Stos logowania (WZORCE-MOBBIN.md 7): e-mail i hasło, kod 2FA, raz po
 * pierwszym logowaniu propozycja Face ID. Ekrany mają własny nagłówek na
 * gradiencie, więc pasek nawigacji tylko na ekranie kodu: przezroczysty,
 * z białym „wstecz”. Po zalogowaniu przekierowuje na Pulpit.
 */
export default function UkladLogowania() {
  const kolory = useKolory();
  if (useSesja().stan === 'aktywna') return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerShown: false, statusBarStyle: 'light', contentStyle: { backgroundColor: kolory.tloGrupowane } }}>
      <Stack.Screen name="index" options={{ title: 'Logowanie' }} />
      <Stack.Screen
        name="kod"
        options={{
          title: '',
          headerShown: true,
          headerTransparent: true,
          headerTintColor: kolory.naGradiencie,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          headerBackTitleStyle: { fontFamily: czcionka('regular') },
        }}
      />
      {/* Propozycja Face ID kończy logowanie: bez cofania do kodu. */}
      <Stack.Screen name="face-id" options={{ title: 'Face ID', gestureEnabled: false }} />
    </Stack>
  );
}
