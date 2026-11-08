import { Stack, useRouter } from 'expo-router';

import { EkranListy } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';

/** Arkusz „Nowa faktura”. Formularz powstaje w etapie M7; tu tylko układ arkusza. */
export default function EkranNowejFaktury() {
  const router = useRouter();
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Anuluj</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" disabled onPress={() => router.back()}>
          Wystaw
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy>
        <StanPusty
          ikona="doc.badge.plus"
          tytul="Formularz w przygotowaniu"
          opis="Tu będzie szybka faktura dla ostatniego kontrahenta."
        />
      </EkranListy>
    </>
  );
}
