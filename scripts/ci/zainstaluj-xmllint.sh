#!/usr/bin/env bash
# Instalacja xmllint (pakiet libxml2-utils) na runnerze GitHuba, z zapasowym
# serwerem pakietów. Woła go .github/workflows/ci.yml przed testami, które
# sprawdzają pliki XML schematem (FA(3), JPK).
#
# Dlaczego zapas: 11.11.2026 od ok. 14:09 UTC serwer pakietów Ubuntu w Azure
# (azure.archive.ubuntu.com) przez ponad godzinę nie rozwiązywał się w DNS
# runnerów („Temporary failure resolving”, apt kończył się kodem 100 po kilku
# minutach czekania). Padały wtedy typy, lint i wszystkie części Vitest w każdym
# PR, choć kod był dobry. Gdy adres Azure się nie rozwiązuje albo instalacja
# z niego pada, bierzemy ten sam pakiet z głównego serwera Ubuntu
# (archive.ubuntu.com). Zwykły przebieg niczego nie zmienia.
set -euo pipefail

MIRROR_AZURE=azure.archive.ubuntu.com
MIRROR_ZAPAS=archive.ubuntu.com

zainstaluj() {
  sudo apt-get update
  sudo apt-get install --yes --no-install-recommends libxml2-utils
}

na_zapasowy() {
  echo "::warning::$1: libxml2-utils z $MIRROR_ZAPAS zamiast $MIRROR_AZURE"
  for plik in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    if [ -f "$plik" ]; then
      sudo sed -i "s#${MIRROR_AZURE//./\\.}#$MIRROR_ZAPAS#g" "$plik"
    fi
  done
}

# Szybka próba DNS (kilka sekund) zamiast minut czekania apt na każdy plik.
if ! timeout 10 getent hosts "$MIRROR_AZURE" >/dev/null 2>&1; then
  na_zapasowy "Adres $MIRROR_AZURE nie rozwiązuje się w DNS"
fi

if ! zainstaluj; then
  na_zapasowy "Instalacja z serwera Azure nie przeszła"
  zainstaluj
fi

xmllint --version
