// Generuje src/komponenty/ikony-remix.ts z pakietu @remixicon/react strony (katalog nadrzędny).
// Uruchom w mobile/: node scripts/ikony-remix.cjs
const path = require('path');
const root = process.argv[2] ?? path.join(__dirname, '..', '..');
const out = process.argv[3] ?? path.join(__dirname, '..', 'src', 'komponenty', 'ikony-remix.ts');
const React = require(root + '/node_modules/react');
const { renderToStaticMarkup } = require(root + '/node_modules/react-dom/server');
const remix = require(root + '/node_modules/@remixicon/react');
const NAZWY = `DashboardLine DashboardFill FileList3Line FileList3Fill ReceiptLine ReceiptFill Book2Line Book2Fill MoreLine MoreFill
ExchangeFundsLine BarChart2Line LineChartLine PieChart2Line FileAddLine ContactsBook3Line Upload2Line Settings3Line RepeatLine AlarmWarningLine InboxArchiveLine Download2Line
SendPlaneLine CheckboxCircleFill CheckboxCircleLine AddLine CheckLine FileUnknowLine FileDownloadLine FileUploadLine AddCircleFill PercentLine PencilLine VerifiedBadgeLine VerifiedBadgeFill
CameraLine CashLine RefreshLine EditBoxLine ShareBoxLine PriceTag3Line EqualizerLine GlobalLine QuestionLine ImageLine UserStarLine UserSearchLine AccountCircleLine TeamLine EditCircleLine
ShieldKeyholeLine ShieldCheckLine FileList2Line LinkM SmartphoneLine MacbookLine SearchLine FileTextLine PlayLine PauseLine ArrowGoBackLine FingerprintLine AlertFill MailUnreadLine MailLine
BankCardLine HistoryLine CheckboxMultipleLine BankLine Building2Line NotificationBadgeLine Notification3Line ArrowUpCircleFill ArrowDownCircleFill ArrowRightSLine ArrowDownSLine ArrowUpSLine
CalendarLine Loader4Line Filter3Line ShareForwardLine DeleteBinLine WalletLine MoneyDollarCircleLine ArrowLeftRightLine CloseLine TimeLine ErrorWarningLine InformationLine LogoutBoxRLine KeyLine ArrowRightUpLine ArrowRightDownLine`.split(/\s+/).filter(Boolean);
const wynik = {};
for (const n of NAZWY) {
  const C = remix['Ri' + n];
  if (!C) { console.error('BRAK', n); process.exitCode = 1; continue; }
  const svg = renderToStaticMarkup(React.createElement(C, { size: 24 }));
  const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  if (vb !== '0 0 24 24' || d.length === 0) { console.error('DZIWNE', n, vb, d.length); process.exitCode = 1; }
  const klucz = n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
  wynik[klucz] = d;
}
const linie = Object.entries(wynik).map(([k, d]) => `  '${k}': ${JSON.stringify(d)},`);
require('fs').writeFileSync(out, `/**
 * Ikony Remix Icon (pakiet \`@remixicon/react\` 4.9.0 strony, Remix Icon License 1.0):
 * te same, co w menu i kartach wersji na komputer (\`lib/dashboard-nav-config.ts\`).
 * Same kształty (siatka 24 x 24), tylko ikony używane w aplikacji.
 *
 * PLIK GENEROWANY. Nowa ikona: dopisz nazwę w \`scripts/ikony-remix.cjs\` i uruchom
 * \`node scripts/ikony-remix.cjs\` w katalogu \`mobile/\`.
 */
export const IKONY = {
${linie.join('\n')}
} as const satisfies Record<string, readonly string[]>;

export type NazwaIkony = keyof typeof IKONY;
`);
console.log('ikon:', Object.keys(wynik).length);
