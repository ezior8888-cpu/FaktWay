import { Stack, useIsPreview, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Share, StyleSheet, View } from 'react-native';

import { bruttoPozycji, DZIS, NAZWA_RODZAJU, nettoPozycji, SPRZEDAWCA, vatPozycji, type Faktura, type StatusKsef } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { OsStatusu, type Krok } from '@/komponenty/os-statusu';
import { PotwierdzenieKsef } from '@/komponenty/potwierdzenie-ksef';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { RzadAkcji, type Akcja } from '@/komponenty/rzad-akcji';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataKrotka, dataPelna, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { udostepnijFakture, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';
import { useTytulNaGradiencie } from '@/wyglad/naglowki';

const NAZWA_STATUSU_KSEF: Record<StatusKsef, string> = {
  przyjeta: 'Przyjęta w KSeF',
  wysylanie: 'Wysyłanie do KSeF',
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
 * Szczegół faktury: odpowiednik `invoices/[id]` w układzie Revolut Business
 * (D14; WZORCE-MOBBIN.md 3.3 i 3.7): kwota, rząd akcji, historia jako oś,
 * potem Nabywca, Pozycje i VAT, Płatność, Dokument, Sprzedawca. Po wysłaniu z
 * formularza na górze karta „Wysyłamy do KSeF” → „Przyjęta w KSeF” (8.4).
 * Rzadsze akcje (XML, korekta, duplikat, cykliczna) w menu „…”.
 */
export default function EkranFaktury() {
  const kolory = useKolory();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, przelaczZaplate, wyslijDoKsef, wrocDoSzkicu, usunSzkic, potwierdzenie, pokazPotwierdzenie } = useStanFaktur();
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

  const stawki = wedlugStawek(f);

  // Rząd akcji przyjętej faktury (WZORCE-MOBBIN.md 3.7); reszta w menu „…”.
  const akcje: Akcja[] = [
    ...(mozeZaplacic
      ? [{ tytul: f.zaplacona ? 'Cofnij zapłatę' : 'Zapłacona', ikona: f.zaplacona ? ('arrow-go-back-line' as const) : ('check-line' as const), onPress: () => przelaczZaplate(f) }]
      : []),
    { tytul: 'E-mail', ikona: 'mail-line', onPress: () => router.push({ pathname: '/faktury/email', params: { id: f.id } }) },
    { tytul: 'PDF', ikona: 'file-download-line', onPress: () => udostepnijFakture(f) },
    ...(status.zalegla
      ? [{ tytul: 'Przypomnij', ikona: 'notification3-line' as const, onPress: () => router.push({ pathname: '/faktury/przypomnienie', params: { id: f.id } }) }]
      : []),
  ];

  // Historia: wystawienie, KSeF, zapłata. Jedna nazwa statusu: „Przyjęta w KSeF” (3.3).
  const kroki: Krok[] = [
    { tytul: f.statusKsef === 'robocza' ? 'Szkic' : 'Wystawiona', opis: dataPelna(f.dataWystawienia), stan: f.statusKsef === 'robocza' ? 'trwa' : 'zrobione' },
    f.statusKsef === 'odrzucona'
      ? { tytul: 'Odrzucona przez KSeF', opis: f.blad?.komunikat, stan: 'blad' }
      : f.statusKsef === 'wysylanie'
        ? { tytul: 'Wysyłanie do KSeF', opis: 'KSeF zwykle potwierdza w kilka sekund', stan: 'trwa' }
        : f.statusKsef === 'przyjeta'
          ? { tytul: 'Przyjęta w KSeF', opis: 'Nabywca widzi ją w KSeF, UPO zapisane', stan: 'zrobione' }
          : { tytul: 'Przyjęcie w KSeF', opis: 'Po wysłaniu szkicu', stan: 'czeka' },
    f.zaplacona
      ? { tytul: 'Zapłacona', stan: 'zrobione' }
      : { tytul: status.zalegla ? 'Po terminie' : 'Czeka na zapłatę', opis: `termin ${dataKrotka(f.terminPlatnosci)}`, stan: status.zalegla ? 'blad' : 'czeka' },
  ];

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

        {!podglad && potwierdzenie === f.id ? (
          <PotwierdzenieKsef
            faktura={f}
            onEmail={() => router.push({ pathname: '/faktury/email', params: { id: f.id } })}
            onUdostepnij={() => udostepnijFakture(f)}
            onGotowe={() => pokazPotwierdzenie(undefined)}
          />
        ) : null}

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
        {!podglad && przyjeta && potwierdzenie !== f.id ? <RzadAkcji akcje={akcje} /> : null}

        {f.blad ? (
          <Sekcja naglowek="Dlaczego KSeF odrzucił fakturę" stopka={f.blad.podpowiedz}>
            <Wiersz tytul={f.blad.komunikat} ikona="alert-fill" ikonaKolor="blad" />
            <Wiersz tytul="Pole" wartosc={f.blad.pole} />
            <Wiersz tytul="Ustawienia KSeF" strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Historia" swobodna>
          <OsStatusu kroki={kroki} />
        </Sekcja>
        {f.numerKsef || przyjeta ? (
          <Sekcja>
            {f.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={f.numerKsef} zaznaczalna /> : null}
            {przyjeta ? <Wiersz tytul="Urzędowe Poświadczenie Odbioru" podtytul="UPO dostępne" strzalka onPress={() => pobierz('UPO (PDF)')} /> : null}
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Nabywca">
          <Wiersz
            tytul={f.kontrahent}
            podtytul={[nabywca?.adres, `NIP: ${f.nipKontrahenta}`, nabywca?.email].filter(Boolean).join('\n')}
            zaznaczalna
          />
          {nabywca ? <Wiersz tytul="Karta kontrahenta" strzalka onPress={() => router.push({ pathname: '/wiecej/kontrahenci/[id]', params: { id: nabywca.id } })} /> : null}
        </Sekcja>

        <Sekcja naglowek="Pozycje">
          {f.pozycje.map((p, i) => (
            <Wiersz
              key={i}
              tytul={p.nazwa}
              podtytul={`${p.ilosc} ${p.jednostka} × ${kwota(p.cenaNetto)} netto · VAT ${p.stawkaVat}%`}
              wartosc={kwota(bruttoPozycji(p))}
              wartoscKolor="etykieta"
            />
          ))}
          {stawki.length > 1
            ? stawki.map(([stawka, w]) => (
                <Wiersz key={`stawka-${stawka}`} tytul={`Stawka ${stawka}%`} podtytul={`Netto ${kwota(w.netto)}, VAT ${kwota(w.vat)}`} wartosc={kwota(w.brutto)} />
              ))
            : null}
          <Wiersz tytul="Razem netto" wartosc={kwota(f.netto)} />
          <Wiersz tytul="VAT" wartosc={kwota(vat)} />
          <Wiersz tytul="Razem brutto" wartosc={kwota(f.brutto)} wartoscKolor="etykieta" />
        </Sekcja>

        <Sekcja naglowek="Płatność">
          <Wiersz tytul="Do zapłaty" wartosc={f.zaplacona ? kwota(0) : kwota(f.brutto)} wartoscKolor="etykieta" />
          <Wiersz tytul="Termin" wartosc={dataPelna(f.terminPlatnosci)} />
          <Wiersz tytul="Forma płatności" wartosc={f.metodaPlatnosci} />
          {f.rachunek ? <Wiersz tytul="Rachunek" podtytul={f.rachunek} zaznaczalna /> : null}
          {f.rachunek ? <Wiersz tytul="Bank" wartosc={SPRZEDAWCA.bank} /> : null}
          {f.mpp ? <Wiersz tytul="MPP" wartosc="Mechanizm podzielonej płatności" /> : null}
        </Sekcja>

        <Sekcja naglowek={`${NAZWA_RODZAJU[f.rodzaj]} nr ${f.numer}`}>
          <Wiersz tytul="Data wystawienia" wartosc={dataPelna(f.dataWystawienia)} />
          {f.rodzaj === 'vat' ? <Wiersz tytul="Data sprzedaży" wartosc={dataPelna(f.dataWystawienia)} /> : null}
          <Wiersz
            tytul="Status KSeF"
            wartosc={NAZWA_STATUSU_KSEF[f.statusKsef]}
            wartoscKolor={f.statusKsef === 'odrzucona' ? 'blad' : f.statusKsef === 'przyjeta' ? 'sukces' : undefined}
          />
        </Sekcja>

        <Sekcja naglowek="Sprzedawca">
          <Wiersz tytul={SPRZEDAWCA.nazwa} podtytul={`${SPRZEDAWCA.adres}\nNIP: ${SPRZEDAWCA.nip}`} zaznaczalna />
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
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m, gap: ODSTEP.s },
});
