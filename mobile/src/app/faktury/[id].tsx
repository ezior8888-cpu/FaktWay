import { Stack, useIsPreview, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Share, StyleSheet, View } from 'react-native';

import { bruttoPozycji, DZIS, NAZWA_RODZAJU, nettoPozycji, SPRZEDAWCA, vatPozycji, type Faktura, type StatusKsef } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataPelna, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { udostepnijFakture, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';
import { useTytulNaGradiencie } from '@/wyglad/naglowki';

const NAZWA_STATUSU_KSEF: Record<StatusKsef, string> = {
  przyjeta: 'Zaakceptowana',
  wysylanie: 'Wysyłanie',
  odrzucona: 'Odrzucona',
  robocza: 'Szkic',
};

/** Podsumowanie VAT według stawek (tabela „Stawka, Netto, VAT, Brutto” ze strony). */
function wedlugStawek(f: Faktura) {
  const mapa = new Map<number, { netto: number; vat: number; brutto: number }>();
  for (const p of f.pozycje) {
    const w = mapa.get(p.stawkaVat) ?? { netto: 0, vat: 0, brutto: 0 };
    mapa.set(p.stawkaVat, { netto: w.netto + nettoPozycji(p), vat: w.vat + vatPozycji(p), brutto: w.brutto + bruttoPozycji(p) });
  }
  return [...mapa.entries()];
}

/**
 * Szczegół faktury: odpowiednik `invoices/[id]` (karta Status z UPO i zapłatą,
 * karta dokumentu, akcje: e-mail, PDF, XML, korekta, duplikat, cykliczna).
 */
export default function EkranFaktury() {
  const kolory = useKolory();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, przelaczZaplate, wyslijDoKsef, wrocDoSzkicu, usunSzkic } = useStanFaktur();
  // W podglądzie z przytrzymania wiersza ekran nie ustawia paska nawigacji.
  const podglad = useIsPreview();
  const { tytul, onScroll, scrollEventThrottle } = useTytulNaGradiencie();
  const f = faktury.find((x) => x.id === id);

  if (!f) {
    return (
      <EkranListy>
        <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej faktury" opis="Mogła zostać usunięta na komputerze." />
      </EkranListy>
    );
  }
  const status = statusFaktury(f, DZIS);
  const mozeZaplacic = doZaplaty(f) || f.zaplacona;
  const przyjeta = f.statusKsef === 'przyjeta';
  const nabywca = KONTRAHENCI.find((k) => k.nazwa === f.kontrahent);
  const vat = f.brutto - f.netto;

  const usun = () =>
    Alert.alert('Usunąć szkic?', 'Numer faktury będzie można użyć ponownie.', [
      { text: 'Anuluj', style: 'cancel' },
      {
        text: 'Usuń szkic',
        style: 'destructive',
        onPress: () => {
          usunSzkic(f.id);
          router.back();
        },
      },
    ]);

  const edytuj = () => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: f.rodzaj, edytuj: f.id, wprost: '1' } });

  const pobierz = (co: string) => void Share.share({ message: `${co}: faktura ${f.numer} (${f.kontrahent}).` });

  return (
    <>
      {podglad ? null : (
        <>
          <Stack.Screen options={{ title: f.numer, headerTitleStyle: tytul }} />
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon={IKONY_PASKA.udostepnij} iconRenderingMode="template" tintColor={kolory.etykieta} accessibilityLabel="Pobierz PDF i udostępnij" onPress={() => udostepnijFakture(f)} />
            <Stack.Toolbar.Menu icon={IKONY_PASKA.wiecej} iconRenderingMode="template" tintColor={kolory.etykieta} title="Akcje faktury">
              <Stack.Toolbar.MenuAction icon="envelope" onPress={() => router.push({ pathname: '/faktury/email', params: { id: f.id } })}>
                Wyślij e-mailem
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="doc.richtext" onPress={() => udostepnijFakture(f)}>
                Pobierz PDF
              </Stack.Toolbar.MenuAction>
              {przyjeta ? (
                <Stack.Toolbar.MenuAction icon="chevron.left.forwardslash.chevron.right" onPress={() => pobierz('XML')}>
                  Pobierz XML
                </Stack.Toolbar.MenuAction>
              ) : null}
              {przyjeta && f.rodzaj !== 'korygujaca' ? (
                <Stack.Toolbar.MenuAction
                  icon="arrow.uturn.left.square"
                  onPress={() => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'korygujaca', z: f.id, wprost: '1' } })}>
                  Korekta
                </Stack.Toolbar.MenuAction>
              ) : null}
              {f.rodzaj === 'vat' ? (
                <Stack.Toolbar.MenuAction icon="plus.square.on.square" onPress={() => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'vat', wzor: f.id, wprost: '1' } })}>
                  Duplikuj
                </Stack.Toolbar.MenuAction>
              ) : null}
              {przyjeta && f.rodzaj === 'vat' ? (
                <Stack.Toolbar.MenuAction icon="arrow.triangle.2.circlepath" onPress={() => router.push({ pathname: '/faktury/cykliczna', params: { wzor: f.id } })}>
                  Ustaw jako cykliczną
                </Stack.Toolbar.MenuAction>
              ) : null}
              {f.statusKsef === 'odrzucona' ? (
                <Stack.Toolbar.MenuAction icon="arrow.uturn.backward" onPress={() => wrocDoSzkicu(f.id)}>
                  Wróć do szkicu
                </Stack.Toolbar.MenuAction>
              ) : null}
              {f.statusKsef === 'robocza' ? (
                <Stack.Toolbar.MenuAction icon="trash" destructive onPress={usun}>
                  Usuń szkic
                </Stack.Toolbar.MenuAction>
              ) : null}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        </>
      )}

      <EkranListy gradient onScroll={onScroll} scrollEventThrottle={scrollEventThrottle}>
        <NaglowekKwoty podpis={f.kontrahent} podpisWyrozniony wartosc={kwota(f.brutto)} status={status.tekst} statusKolor={status.kolor} />

        {!podglad && (f.statusKsef === 'robocza' || f.statusKsef === 'odrzucona') ? (
          <View style={styles.akcja}>
            {f.statusKsef === 'robocza' ? (
              <>
                <PrzyciskGlowny tytul="Wyślij do KSeF" ikona="send-plane-line" onPress={() => wyslijDoKsef(f.id)} />
                <PrzyciskGlowny tytul="Edytuj" ikona="pencil-line" wariant="drugorzedny" onPress={edytuj} />
              </>
            ) : (
              // Odrzucona: najpierw poprawka (np. NIP), ponowna wysyłka bez zmian jako druga droga.
              <>
                <PrzyciskGlowny tytul="Popraw fakturę" ikona="pencil-line" onPress={edytuj} />
                <PrzyciskGlowny tytul="Wyślij ponownie bez zmian" ikona="send-plane-line" wariant="drugorzedny" onPress={() => wyslijDoKsef(f.id)} />
              </>
            )}
          </View>
        ) : null}
        {!podglad && mozeZaplacic && przyjeta ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul={f.zaplacona ? 'Cofnij zapłatę' : 'Zapłacone'}
              ikona={f.zaplacona ? 'arrow-go-back-line' : 'check-line'}
              wariant={f.zaplacona ? 'drugorzedny' : 'glowny'}
              onPress={() => przelaczZaplate(f)}
            />
          </View>
        ) : null}

        {f.blad ? (
          <Sekcja naglowek="Dlaczego KSeF odrzucił fakturę" stopka={f.blad.podpowiedz}>
            <Wiersz tytul={f.blad.komunikat} ikona="alert-fill" ikonaKolor="blad" />
            <Wiersz tytul="Pole" wartosc={f.blad.pole} />
            <Wiersz tytul="Ustawienia KSeF" strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
          </Sekcja>
        ) : null}

        <Sekcja
          naglowek="Status"
          stopka={
            f.statusKsef === 'wysylanie'
              ? 'Status odświeży się sam, gdy KSeF potwierdzi przyjęcie.'
              : f.statusKsef === 'robocza'
                ? 'Szkic nie trafił jeszcze do KSeF.'
                : undefined
          }>
          <Wiersz
            tytul="KSeF"
            wartosc={NAZWA_STATUSU_KSEF[f.statusKsef]}
            wartoscKolor={f.statusKsef === 'odrzucona' ? 'blad' : f.statusKsef === 'przyjeta' ? 'sukces' : undefined}
          />
          {f.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={f.numerKsef} zaznaczalna /> : null}
          {przyjeta ? (
            <Wiersz tytul="Urzędowe Poświadczenie Odbioru" podtytul="UPO dostępne" ikona="verified-badge-line" ikonaKolor="sukces" strzalka onPress={() => pobierz('UPO (PDF)')} />
          ) : null}
          {f.zaplacona && przyjeta ? <Wiersz tytul="Płatność" wartosc="Zapłacona" wartoscKolor="sukces" /> : null}
        </Sekcja>

        <Sekcja naglowek={`${NAZWA_RODZAJU[f.rodzaj]} nr ${f.numer}`}>
          <Wiersz tytul="Data wystawienia" wartosc={dataPelna(f.dataWystawienia)} />
          {f.rodzaj === 'vat' ? <Wiersz tytul="Data sprzedaży" wartosc={dataPelna(f.dataWystawienia)} /> : null}
          <Wiersz tytul="Termin płatności" wartosc={dataPelna(f.terminPlatnosci)} />
        </Sekcja>

        <Sekcja naglowek="Sprzedawca">
          <Wiersz tytul={SPRZEDAWCA.nazwa} podtytul={`${SPRZEDAWCA.adres}\nNIP: ${SPRZEDAWCA.nip}`} zaznaczalna />
        </Sekcja>

        <Sekcja naglowek="Nabywca">
          <Wiersz
            tytul={f.kontrahent}
            podtytul={[nabywca?.adres, `NIP: ${f.nipKontrahenta}`, nabywca?.email].filter(Boolean).join('\n')}
            zaznaczalna
          />
          {nabywca ? <Wiersz tytul="Karta kontrahenta" strzalka onPress={() => router.push({ pathname: '/wiecej/kontrahenci/[id]', params: { id: nabywca.id } })} /> : null}
        </Sekcja>

        <Sekcja naglowek="Płatność">
          <Wiersz tytul="Do zapłaty" wartosc={f.zaplacona ? kwota(0) : kwota(f.brutto)} wartoscKolor="etykieta" />
          <Wiersz tytul="Forma płatności" wartosc={f.metodaPlatnosci} />
          {f.rachunek ? <Wiersz tytul="Rachunek" podtytul={f.rachunek} zaznaczalna /> : null}
          {f.rachunek ? <Wiersz tytul="Bank" wartosc={SPRZEDAWCA.bank} /> : null}
          {f.mpp ? <Wiersz tytul="MPP" wartosc="Mechanizm podzielonej płatności" /> : null}
        </Sekcja>

        <Sekcja naglowek="Pozycje">
          {f.pozycje.map((p, i) => (
            <Wiersz
              key={i}
              tytul={`${i + 1}. ${p.nazwa}`}
              podtytul={`${p.ilosc} ${p.jednostka} × ${kwota(p.cenaNetto)} netto, VAT ${p.stawkaVat}%`}
              wartosc={kwota(bruttoPozycji(p))}
              wartoscKolor="etykieta"
            />
          ))}
        </Sekcja>

        <Sekcja naglowek="Podsumowanie VAT">
          {wedlugStawek(f).map(([stawka, w]) => (
            <Wiersz key={stawka} tytul={`Stawka ${stawka}%`} podtytul={`Netto ${kwota(w.netto)}, VAT ${kwota(w.vat)}`} wartosc={kwota(w.brutto)} />
          ))}
          <Wiersz tytul="Razem netto" wartosc={kwota(f.netto)} />
          <Wiersz tytul="VAT" wartosc={kwota(vat)} />
          <Wiersz tytul="Razem brutto" wartosc={kwota(f.brutto)} wartoscKolor="etykieta" />
        </Sekcja>

        {f.uwagi ? (
          <Sekcja naglowek="Uwagi">
            <Wiersz tytul={f.uwagi} />
          </Sekcja>
        ) : null}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l, gap: ODSTEP.s },
});
