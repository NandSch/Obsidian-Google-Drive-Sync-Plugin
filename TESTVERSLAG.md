# Testverslag — Drive Vault Sync 1.2.1

Datum: 27 oktober 2026. Platform: Windows. Build: TypeScript met strikte typecontrole, gevolgd door een esbuild-bundel voor Obsidian Desktop.

## Resultaat

| Controle | Uitkomst |
| --- | --- |
| `npm run build` | Geslaagd |
| Node test runner | **135 geslaagd, 0 mislukt, 0 overgeslagen** |
| PowerShell-installertests | **6 geslaagd, 0 mislukt** |
| npm-audit tijdens installatie van ontwikkelafhankelijkheden | 0 gemelde kwetsbaarheden op dat moment |
| SHA-256-controles van installatiebestanden | Gecontroleerd door installer en verpakking |

## Wat de 135 tests controleren

- De driewegvergelijking voor ongewijzigde, nieuwe, gewijzigde en verwijderde inhoud aan beide kanten.
- De verplichte volgorde: alle geplande downloads afronden voordat inhoudsupdates worden geüpload.
- Beide inhoudsversies behouden bij een eerste-synchronisatieconflict en hergebruik van identieke conflictkopieën.
- Geen uploadfase na een mislukte download.
- Geen lokale overschrijving als een bestand tijdens een download verandert.
- Verschil tussen aantoonbare prullenbakstatus en onbekende of ingetrokken toegang.
- Herstel van gewijzigd werk wanneer de andere kant het bestand heeft verwijderd.
- Prullenbak en afzonderlijke backups bij lokale en externe verwijderingen.
- Het vooraf bekijken van acties zonder vaultinhoud te wijzigen.
- Checkpoints na geslaagde acties, ook wanneer een latere actie mislukt.
- Annulering en grenzen voor aantallen en percentages verwijderingen.
- Begrensd aantal statuswrites bij veel ongewijzigde bestanden.
- Uitsluiten van configuratie, verborgen inhoud en eigen mapprefixen.
- Windows-namen, padreizen, Unicode- en hoofdletterconflicten en bestand/mapbotsingen.
- Recursieve Drive-inventarisatie, paginering en afwijzen van onvolledige lijsten.
- Dubbele Drive-namen, Google-documenten, snelkoppelingen en ongeschikte roots.
- Downloadcontrole met ETags, checksums en byteaantallen.
- Vooraf gereserveerde Drive-IDs en herstel van een verloren succesvol aanmaakantwoord.
- Herstel van een uploadjournaal met controle op werkelijk bevestigde inhoud.
- Voorwaardelijke updates en geen blinde schrijfherhaling na HTTP 412.
- Gelijktijdige aanmaak, verplaatsing buiten de vaultmap en maphernoeming.
- Nieuwe mappen met gereserveerde IDs en voorwaardelijke Drive-prullenbakacties.
- Oplopende herhaalvertraging, eenmalige tokenvernieuwing en permanente rechtenfouten.
- Uploads in meerdere blokken, hervatten op serverbevestigde offset en herstel na een verloren laatste antwoord.
- Blokkeren van de laatste uploadstap bij tussentijds gewijzigde Drive-inhoud.
- Bescherming tegen een uploadadres op een ander domein en ongeldige bytebereiken.
- Werkelijke lokale tekst- en binaire bestandsacties, backups, oudermappen en prullenbak in een tijdelijke testvault.
- Open editorinhoud, CRLF/LF-normalisatie en bestanden die op schijf afwijken van de planning.
- Werkelijke Windows-junctions die lokale downloads zouden kunnen omleiden.
- Atomische statusvervanging, een eerder checkpoint in `.bak` en ongeldige statusschema's.
- Exclusieve processloten, eigenaarcontrole en onleesbare sloten.
- PKCE met een gepubliceerde S256-testvector en strikte OAuth-statecontrole.
- Een echte HTTP-loopbackcallback met een geweigerde verkeerde state en een geaccepteerde juiste state.
- SecretStorage-integratie via testdouble, geserialiseerde tokenvernieuwing, tokenrotatie en foutmeldingen zonder tokeninhoud.
- Afmelden, annuleren, ontbrekende scopes en herstel van beschadigde opgeslagen aanmeldgegevens.
- Begrensde afsluitsynchronisatie, geslaagde afronding, netwerkfout en een onresponsieve worker.
- Beide aankomstvolgordes van native `close` en renderer-`quit`, zonder dubbel werk of te vroeg sluiten vóór andere quit-taken.
- Herhaalde sluitverzoeken, de overslaanknop, pluginuitschakeling en een falende native sluitbrug.
- Open editors opslaan vóór de laatste inventarisatie, een opslagfout en annulering tussen twee editors.
- De echte plugincoördinatie met een nog lopende ronde: eerst stoppen/afwachten, dan editorbewaring, dan een nieuwe sync.
- Pauzeren en de afsluitinstelling respecteren, en de native listener opruimen bij pluginuitschakeling.
- Een duurzame onbevestigde afsluitmarkering, herstel na een volgende bevestigde sync, beschadigde JSON en junctionbescherming.
- Obsidian's hoofdmapobject met pad `/` in de lokale bestandslijst, behoud van gewone submappen en notities, en een lege vault met alleen het hoofdmapobject.
- Alleen het echte hoofdmapobject overslaan; andere absolute of onveilige paden blijven geweigerd.
- De voortgang volgt de echte pipeline en telt een overdracht pas na het checkpoint; conflictkopieën tellen mee in de uploadfase.
- Drive-pagina's rapporteren lopende aantallen zonder verzonnen totaal; lokale voortgang telt alleen opgenomen bestanden.
- Een voorstel rapporteert geen overdrachten of afgeronde sync; een mislukte download verhoogt de teller niet en start geen uploads.
- Een fout in een voortgangsobserver kan de engine niet onderbreken of het syncresultaat veranderen.
- De popup toont een onbekend totaal als onbepaald en bekende aantallen als percentages van de huidige fase.
- Stoppen, verbergen zonder annuleren en heropenen met de laatste aantallen; herhaald klikken op Nu synchroniseren heropent de popup.
- Fouten en annulering tonen geen afgeronde balk; bestandsnamen en fouttekst worden als tekst weergegeven.
- Opruimen van meldingen en timers, inclusief een volgende sync die begint voordat de vorige eindmelding verdwijnt.
- Een automatische poll zonder Google-koppeling opent geen voortgangspopup.

De regressietest voor `/` is eerst tegen de oude adapter uitgevoerd: hij produceerde exact de gerapporteerde melding `Onveilige of niet-ondersteunde bestandsnaam: /`. De testdouble geeft de hoofdmap nu standaard mee aan alle lokale scantests. Na de reparatie slagen deze scans zonder de algemene padvalidatie te versoepelen.

## Wat de zes installertests controleren

1. `-WhatIf` maakt niets in de testvault aan.
2. De drie pluginbestanden worden met identieke bytes geïnstalleerd.
3. Een update behoudt `data.json` en `sync-state.json` en bewaart oudere pluginbinaries.
4. Een aangepaste configuratiemap werkt.
5. Een configuratiepad met `..` wordt geweigerd.
6. Een installatiepakket met een gewijzigde `main.js` en niet-bijgewerkte controlehash wordt geweigerd.

## Grenzen van het bewijs

De Drive-API wordt in de tests nagebootst. Er is **geen live Google-account gekoppeld** en er zijn geen echte Drive-bestanden gemuteerd. De lokale Obsidian-adapter gebruikt echte tijdelijke bestanden met een testdouble van de publieke Obsidian-API. Er is **geen volledige gebruikerstest binnen een draaiende Obsidian-app** uitgevoerd.

De popup-tests gebruiken een kleine DOM- en Notice-testdouble. Zij controleren de inhoud, bediening, percentages en levenscyclus; dit is geen visuele controle van alle Obsidian-thema's of van het echte meldingengebied. De voortgang is gebaseerd op afgeronde bestanden per fase, niet op werkelijk verzonden bytes binnen één groot bestand.

Voor 1.2.1 is een vaste, smalle popupvoorbeeldpagina met de echte `styles.css` in een lichte viewport visueel gecontroleerd. De balk, het lange relatieve pad en beide knoppen waren volledig zichtbaar binnen een melding van circa 286 pixels breed. Deze controle bewijst de responsieve CSS-opbouw, maar is geen opname van de echte Obsidian-meldingscontainer of ieder afzonderlijk thema.

Voor de afsluitfunctie zijn de lifecyclepassages in de lokaal geïnstalleerde Obsidian 1.14.5 statisch gelezen. De native Electron-events, DOM-voortgangsweergave en Workspace-quit-afhandeling zijn in de tests nagebootst; een echte venstersluiting met Google-overdracht is nog niet bewezen. De tests leveren ook geen gemeten doorlooptijd voor een echte vault. Verifieer in de proefvault dat normaal sluiten met een laatste wijziging, offline sluiten en een ingestelde korte timeout het bedoelde gedrag geven.

De echte loopbacktest bewijst het lokale callbackgedrag; zij bewijst niet dat een nog aan te maken Google OAuth-client al correct is ingesteld. De tests bewijzen ook geen absolute veiligheid bij schijf- of stroomuitval, gelijktijdige externe binaire schrijvers of ongedocumenteerd servergedrag.

Voor ingebruikname hoort de eerste live controle daarom met een kleine proefvault te gebeuren: aanmelden, één upload, één download, een conflict, een netwerkonderbreking en herstel van een backup. De plugin staat bij het kiezen van een nieuwe Drive-map op handmatig synchroniseren en met verwijderingen uit.

## Zelf herhalen

```powershell
npm ci --ignore-scripts
npm run check
& './tests/installer.test.ps1'
```

Gebruik Node.js 22 of nieuwer en voer de laatste regel op Windows uit. De testomgeving moet lokale loopbackverbindingen en tijdelijke junctions onder `.test-build` toestaan. De tests gebruiken geen persoonlijke Google-credentials.
