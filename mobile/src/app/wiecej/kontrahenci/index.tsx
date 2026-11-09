import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { kwota } from '@/lib/format';
import { doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';

/**
 * Kontrahenci: odpowiednik `contractors` (zapisani z faktur, dane z GUS,
 * należności, zaległości, status VAT). Nowych dodaje się przez fakturę.
 */
export default function EkranKontrahentow() {
  const router = useRouter();
  const { faktury, flagi } = useStanFaktur();
  const [szukaj, setSzukaj] = useState('');
  const fraza = szukaj.trim().toLocaleLowerCase('pl');
  const lista = KONTRAHENCI.filter((k) => !flagi[`kontrahent-usuniety-${k.id}`]).filter((k) => !fraza || k.nazwa.toLocaleLowerCase('pl').includes(fraza) || k.nip.includes(fraza));
  const naleznosci = (nazwa: string) => faktury.filter((f) => f.kontrahent === nazwa && doZaplaty(f));
  const zZaleglosciami = KONTRAHENCI.filter((k) => naleznosci(k.nazwa).some((f) => statusFaktury(f, DZIS).zalegla)).length;

  return (
    <>
      <Stack.SearchBar placeholder="Nazwa albo NIP" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      <EkranListy keyboardShouldPersistTaps="handled">
        {szukaj ? null : (
          <Kafle
            kafle={[
              { klucz: 'wszyscy', podpis: 'Kontrahenci', wartosc: String(KONTRAHENCI.length) },
              { klucz: 'aktywni', podpis: 'Aktywni (90 dni)', wartosc: String(KONTRAHENCI.length - 1) },
              { klucz: 'zalegli', podpis: 'Z zaległościami', wartosc: String(zZaleglosciami), opisKolor: 'ostrzezenie' },
              { klucz: 'vat', podpis: 'Status VAT do sprawdzenia', wartosc: '0' },
            ]}
          />
        )}
        {lista.length === 0 ? (
          <StanPusty ikona="person.crop.rectangle.stack" tytul="Brak kontrahentów" opis={szukaj ? `Nic nie pasuje do „${szukaj}”.` : 'Kontrahentów zapisujemy z wystawionych faktur.'} />
        ) : (
          <Sekcja naglowek="Wszyscy" stopka="Zapisani automatycznie z faktur. Dane pobieramy z bazy GUS REGON.">
            {lista.map((k) => {
              const otwarte = naleznosci(k.nazwa);
              const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);
              return (
                <Wiersz
                  key={k.id}
                  tytul={k.nazwa}
                  podtytul={`NIP ${k.nip} · Czynny VAT`}
                  wartosc={otwarte.length > 0 ? kwota(otwarte.reduce((s, f) => s + f.brutto, 0)) : undefined}
                  wartoscKolor="etykieta"
                  wartoscPodpis={zalegle.length > 0 ? `${ileFaktur(zalegle.length)} po terminie` : otwarte.length > 0 ? 'Należności' : undefined}
                  wartoscPodpisKolor={zalegle.length > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
                  strzalka
                  onPress={() => router.push({ pathname: '/wiecej/kontrahenci/[id]', params: { id: k.id } })}
                />
              );
            })}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}
