#!/usr/bin/env bash
# Instalacja xmllint (pakiet libxml2-utils) na runnerze GitHuba, z zapasowym
# serwerem pakietów. Woła go .github/workflows/ci.yml przed testami, które
# sprawdzają pliki XML schematem (FA(3), JPK).
#
# Dlaczego zapas: 11.11.2026 od ok. 14:09 UTC serwer pakietów Ubuntu w Azure
# (azure.archive.ubuntu.com) przez ponad godzinę nie rozwiązywał się w DNS
# runnerów („Temporary failure resolving”, apt kończył się kodem 100). Padały
# wtedy typy, lint i wszystkie części Vitest w każdym PR, choć kod był dobry.
# Przy takiej porażce bierzemy ten sam pakiet z głównego serwera Ubuntu
# (archive.ubuntu.com). Zwykły przebieg niczego nie zmienia: pierwsza próba idzie
# jak dotąd przez serwer Azure.
set -euo pipefail

zainstaluj() {
  sudo apt-get update -o Acquire::Retries=3
  sudo apt-get install --yes --no-install-recommends -o Acquire::Retries=3 libxml2-utils
}

if ! zainstaluj; then
  echo "::warning::Serwer pakietów Azure nie odpowiada, libxml2-utils z archive.ubuntu.com"
  for plik in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    if [ -f "$plik" ]; then
      sudo sed -i 's#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g' "$plik"
    fi
  done
  zainstaluj
fi

xmllint --version
