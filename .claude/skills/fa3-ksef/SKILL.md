---
name: fa3-ksef
description: Reguły schematu FA(3) i wysyłki KSeF. Użyj przed zmianą generatora albo walidatora XML w lib/xml/ albo wysyłki w lib/ksef/.
---

Przeczytaj `docs/runbooks/fa3-ksef.md` (identyfikator nabywcy bez `NrPESEL`, `P_12`, `RodzajFaktury`, walidacja XSD przed wysyłką). Po zmianie generatora uruchom `pnpm verify:fa3` i `pnpm test`. W testach tylko NIP `1234567890`.
