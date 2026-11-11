#!/usr/bin/env bash
# Instalacja xmllint (pakiet libxml2-utils) na runnerze GitHuba, z zapasowymi
# serwerami pakietów. Woła go .github/workflows/ci.yml przed testami, które
# sprawdzają pliki XML schematem (FA(3), JPK).
#
# Dlaczego zapas: 11.11.2026 od ok. 14:09 UTC runnery GitHuba nie rozwiązywały
# w DNS żadnego serwera z domeny ubuntu.com (azure.archive, archive, security;
# „Temporary failure resolving”, apt kończył się kodem 100 po kilku minutach).
# Padały wtedy typy, lint i wszystkie części Vitest w każdym PR, choć kod był
# dobry. Skrypt w kilka sekund sprawdza DNS kandydatów i bierze pierwszy, który
# się rozwiązuje; ostatni to oficjalny mirror Ubuntu spoza ubuntu.com
# (mirrors.edge.kernel.org), z tymi samymi pakietami i wersjami. Zwykły przebieg
# niczego nie zmienia: pierwszy kandydat to domyślny serwer Azure.
set -euo pipefail

KANDYDACI=(
  "azure.archive.ubuntu.com/ubuntu"
  "archive.ubuntu.com/ubuntu"
  "mirrors.edge.kernel.org/ubuntu"
)

wybrany=""
for kandydat in "${KANDYDACI[@]}"; do
  host=${kandydat%%/*}
  if timeout 10 getent hosts "$host" >/dev/null 2>&1; then
    wybrany=$kandydat
    break
  fi
  echo "::warning::$host nie rozwiązuje się w DNS"
done

if [ -z "$wybrany" ]; then
  echo "::error::Żaden serwer pakietów Ubuntu nie rozwiązuje się w DNS: ${KANDYDACI[*]}"
  exit 1
fi

if [ "$wybrany" != "${KANDYDACI[0]}" ]; then
  echo "::warning::libxml2-utils z http://$wybrany zamiast domyślnego serwera Azure"
  echo "http://$wybrany/" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  for plik in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    if [ -f "$plik" ]; then
      sudo sed -i -E "s#https?://[a-z0-9.-]*ubuntu\.com/ubuntu/?#http://$wybrany/#g" "$plik"
    fi
  done
fi

sudo apt-get update
sudo apt-get install --yes --no-install-recommends libxml2-utils
xmllint --version
