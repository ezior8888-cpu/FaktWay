#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Publiczna kontrola nowej domeny faktway.pl (bramki B, C i F planu
# docs/rebrand/FAKTWAY.md). Tylko odczyt z internetu — bez SSH, bez kluczy.
#
# Uruchomienie: ./scripts/ops/faktway-sprawdz.sh
#
# Każda linia to OK / BRAK z wyjaśnieniem. Kod wyjścia 0 tylko wtedy, gdy
# wszystkie kontrole są OK. Stara domena jest sprawdzana obok — ma działać
# przez cały okres przejściowy.
# ════════════════════════════════════════════════════════════════

set -uo pipefail

NEW=faktway.pl
OLD=faktflow.pl
FAILS=0

ok()   { printf '  OK    %s\n' "$1"; }
bad()  { printf '  BRAK  %s\n' "$1"; FAILS=$((FAILS + 1)); }
info() { printf '  ·     %s\n' "$1"; }

a_record() { dig +short "$1" A | grep -E '^[0-9.]+$' | sort | tr '\n' ' ' | sed 's/ $//'; }

cert_ok() {
  # Certyfikat musi obejmować host (nie domyślny certyfikat Traefika).
  local host=$1 names
  names=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed 's/.*DNS://' | tr -d ' ')
  grep -qx "$host" <<<"$names" || grep -qx "*.${host#*.}" <<<"$names"
}

http_code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@"; }

echo "── DNS: nowe hosty celują tam, gdzie stare"
for sub in "" www. db. s3.; do
  new_ip=$(a_record "$sub$NEW"); old_ip=$(a_record "$sub$OLD")
  if [ -z "$new_ip" ]; then bad "$sub$NEW: brak rekordu A"
  elif [ "$new_ip" = "$old_ip" ]; then ok "$sub$NEW → ten sam serwer co $sub$OLD"
  else bad "$sub$NEW → inny adres niż $sub$OLD (sprawdź, czy celowo)"; fi
done

echo "── Certyfikaty TLS (Coolify/Traefik musi znać host)"
for host in "$NEW" "www.$NEW" "db.$NEW" "s3.$NEW"; do
  if cert_ok "$host"; then ok "$host: certyfikat na tę nazwę"
  else bad "$host: domyślny certyfikat Traefika — domena nie jest jeszcze dopisana w Coolify"; fi
done

echo "── Usługi pod nowymi adresami"
code=$(http_code "https://$NEW/api/health")
[ "$code" = 200 ] && ok "https://$NEW/api/health → 200" || bad "https://$NEW/api/health → $code (oczekiwane 200)"
code=$(http_code "https://www.$NEW/api/health")
[ "$code" = 200 ] && ok "https://www.$NEW/api/health → 200" || bad "https://www.$NEW/api/health → $code (oczekiwane 200)"
# Kong bez klucza odpowiada 401 — to znaczy, że brama Supabase jest osiągalna.
code=$(http_code "https://db.$NEW/auth/v1/health")
case "$code" in
  200|401) ok "https://db.$NEW/auth/v1/health → $code (brama Supabase odpowiada)" ;;
  *) bad "https://db.$NEW/auth/v1/health → $code (oczekiwane 200 albo 401)" ;;
esac
code=$(http_code "https://s3.$NEW/minio/health/live")
[ "$code" = 200 ] && ok "https://s3.$NEW/minio/health/live → 200" || bad "https://s3.$NEW/minio/health/live → $code (oczekiwane 200)"

echo "── Poczta $NEW (Cloudflare Email Routing + Resend)"
mx=$(dig +short "$NEW" MX)
grep -q 'mx.cloudflare.net' <<<"$mx" && ok "MX → Cloudflare Email Routing" || bad "MX: brak rekordów Cloudflare Email Routing"
spf_count=$(dig +short "$NEW" TXT | grep -c 'v=spf1')
spf=$(dig +short "$NEW" TXT | grep 'v=spf1')
if [ "$spf_count" -ne 1 ]; then bad "SPF: $spf_count rekordów v=spf1 (musi być dokładnie jeden)"
elif grep -q '_spf.mx.cloudflare.net' <<<"$spf" && grep -q '_spf.resend.com' <<<"$spf"; then ok "SPF: jeden rekord, Cloudflare + Resend"
else bad "SPF: brak include Cloudflare albo Resend: $spf"; fi
dkim=$(dig +short "resend._domainkey.$NEW" TXT)
[ -n "$dkim" ] && ok "DKIM resend._domainkey.$NEW" || bad "DKIM: brak resend._domainkey.$NEW"
dig +short "send.$NEW" MX | grep -q amazonses && ok "send.$NEW MX (zwroty Resend)" || bad "send.$NEW: brak MX zwrotów Resend"
dmarc=$(dig +short "_dmarc.$NEW" TXT)
grep -q "rua=mailto:dmarc@$NEW" <<<"$dmarc" && ok "DMARC z raportami na dmarc@$NEW" || bad "DMARC: $dmarc"
if dig +short "$NEW" TXT | grep -qx '"resend._domainkey"'; then
  info "Na $NEW (i $OLD) jest zbędny rekord TXT o treści \"resend._domainkey\" — pomyłka przy wklejaniu, można usunąć."
fi
for sub in app hello; do
  if [ -n "$(dig +short "resend._domainkey.$sub.$NEW" TXT)" ]; then ok "Resend: $sub.$NEW ma DKIM"
  else info "Resend: $sub.$NEW bez DKIM — jeśli nadawca to no-reply@app.$NEW / hello@hello.$NEW, ta subdomena musi być zweryfikowana w Resend"; fi
done

echo "── Stara domena działa dalej"
code=$(http_code "https://$OLD/api/health")
[ "$code" = 200 ] && ok "https://$OLD/api/health → 200" || bad "https://$OLD/api/health → $code"
code=$(http_code "https://db.$OLD/auth/v1/health")
case "$code" in 200|401) ok "https://db.$OLD/auth/v1/health → $code" ;; *) bad "https://db.$OLD/auth/v1/health → $code" ;; esac
loc=$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "https://$OLD/pomoc?x=1")
case "$loc" in
  "308 https://$NEW/pomoc?x=1") info "https://$OLD/pomoc → 308 na $NEW (LEGACY_HOST_REDIRECT włączone)" ;;
  200*) info "https://$OLD/pomoc → 200 (przekierowanie starej domeny jeszcze wyłączone)" ;;
  *) bad "https://$OLD/pomoc → $loc (ani 200, ani 308 na $NEW)" ;;
esac

echo
if [ "$FAILS" -eq 0 ]; then echo "Wszystko OK."; else echo "Braki: $FAILS (szczegóły wyżej)."; fi
exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 1)
