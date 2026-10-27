# Drive Vault Sync 1.2.1

Een Obsidian Desktop-plugin die je notities en bijlagen synchroniseert met een gewone map in Google Drive. Iedere ronde verwerkt eerst de wijzigingen van Drive op je pc en uploadt daarna lokale wijzigingen. De instellingen en meldingen zijn in het Nederlands.

Vanaf **1.2.0** verschijnt een voortgangspopup bij handmatige en automatische synchronisaties. **1.2.1** corrigeert de weergave: de popup gebruikt de achtergrond-, tekst- en accentkleuren van je actieve Obsidian-thema. De voortgangsbalk, lange bestandsnamen en knoppen blijven binnen de melding, ook in een smalle weergave. Het afsluitvenster gebruikt dezelfde themakleuren en responsieve breedte.

Versie **1.1.1** herstelt de fout `Onveilige of niet-ondersteunde bestandsnaam: /` bij **Nu synchroniseren**, het voorstel en de afsluitsync. Obsidian geeft ook de hoofdmap mee in zijn bestandslijst; die werd ten onrechte als relatief bestandspad gecontroleerd. De scan slaat nu uitsluitend het echte hoofdmapobject over. De beveiliging van overige paden blijft actief.

**Bijwerken vanaf een eerdere versie:** sluit Obsidian en vervang alleen `main.js`, `manifest.json` en `styles.css` in `JOUW-VAULT/.obsidian/plugins/drive-vault-sync/` door de bestanden uit het nieuwe installatie-ZIP. Verwijder de pluginmap niet: laat `data.json`, `sync-state.json` en andere bestaande statusbestanden staan. Je kunt ook het meegeleverde `Install.ps1` gebruiken. Open Obsidian opnieuw en controleer in Community plugins dat versie **1.2.1** actief is. Opnieuw aanmelden bij Google of een nieuwe OAuth-client maken is voor deze update niet nodig.

## Wat je krijgt

- Automatische synchronisatie bij starten, lokale wijzigingen, terugkeer naar het venster en periodiek zolang Obsidian draait.
- Een voortgangspopup voor handmatige en automatische rondes, met huidige fase, bestand, aantallen en knoppen om te stoppen of te verbergen.
- Een laatste synchronisatie vóór afsluiten, met een voortgangsvenster en standaard maximaal 30 seconden extra wachttijd.
- Vergelijking van bestandsinhoud met de vorige sync, in plaats van uitsluitend wijzigingsdatums.
- Beide versies bewaren bij conflicten. De Drive-versie krijgt de oorspronkelijke naam; jouw lokale versie krijgt bijvoorbeeld `Notitie (conflict lokaal abc123def456).md` en wordt daarna ook geüpload.
- Lokale herstelkopieën vóór overschrijven en verwijderen, inclusief een kopie van Drive-inhoud voordat deze wordt vervangen.
- Verwijderingen standaard uitgeschakeld. Optioneel prullenbakgebruik met een grens voor massaverwijderingen.
- Een voorstel bekijken zonder vaultbestanden te wijzigen, handmatig synchroniseren, pauzeren en stoppen.
- Ondersteuning voor gewone bestanden tot **100 MiB per bestand**. Uploads boven 5 MiB verlopen in delen van maximaal 8 MiB.
- Broncode, geautomatiseerde tests en een los testverslag.

De plugin is gebouwd en lokaal getest. Er is nog geen aanmelding met jouw Google-account uitgevoerd en er is niets in jouw bestaande vault geïnstalleerd of gewijzigd. De tests gebruiken een nagebootste Drive-API; de OAuth-terugkoppeling en lokale bestandsbewerkingen zijn wel echt op Windows getest.

## 1. Plugin installeren

Je hebt **Obsidian Desktop 1.11.4 of nieuwer** nodig. De plugin gebruikt de officiële SecretStorage-API die sinds die versie beschikbaar is. Zie de [Obsidian API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) en de [handleiding voor secrets](https://docs.obsidian.md/plugins/guides/secret-storage).

Pak het installatie-ZIP uit. Kopieer de map `drive-vault-sync` naar:

```text
JOUW-VAULT/.obsidian/plugins/drive-vault-sync/
```

Deze map bevat onder andere `main.js`, `manifest.json` en `styles.css`. Gebruik jouw eigen configuratiemap wanneer je `.obsidian` hebt aangepast. Sluit Obsidian tijdens het kopiëren en open het daarna opnieuw. Schakel **Drive Vault Sync** in via **Instellingen → Community plugins**. Het pakket is bedoeld voor handmatige installatie; het is niet gepubliceerd in de communitycatalogus.

Het meegeleverde PowerShell-script kan dezelfde installatie uitvoeren. Het controleert de meegeleverde bestandshashes, bewaart bestaande pluginbinaries in een installatiereservemap en laat bestaande instellingen en syncgeschiedenis staan:

```powershell
.\Install.ps1 -VaultPath 'C:\pad\naar\Mijn Vault'
```

Bij een aangepaste configuratiemap:

```powershell
.\Install.ps1 -VaultPath 'C:\pad\naar\Mijn Vault' -ConfigDir '.mijn-config'
```

Gebruik `-WhatIf` om de installatiestap vooraf te bekijken. Het script schakelt de plugin niet automatisch in. Je hoeft geen Node.js te installeren om de gebouwde plugin te gebruiken.

## 2. Een eigen Google-aanmelding instellen

Er is bewust geen centraal account, gedeelde OAuth-client of tussenserver ingebouwd. Je gebruikt je eigen Google Cloud-project en de plugin communiceert rechtstreeks met Google.

1. Open [Google Cloud Console](https://console.cloud.google.com/) en maak of selecteer een project.
2. Activeer de **Google Drive API** via de API-bibliotheek.
3. Configureer **Google Auth Platform**: de appnaam, jouw e-mailadres en de doelgroep. Voeg bij een externe app in testmodus jouw eigen Google-account als testgebruiker toe.
4. Voeg bij de gevraagde toegang de scope `https://www.googleapis.com/auth/drive` toe.
5. Maak bij **Clients** een OAuth-client van het type **Desktop app**. Kies geen webapp, Android-client of serviceaccount.
6. Bewaar de **client-ID** en **client secret** voor de plugininstellingen. Vul ze alleen in je lokale plugin in; plaats ze niet in notities of de broncode.

Google beschrijft deze Desktop OAuth-flow, inclusief de systeembrowser en PKCE, in zijn [officiële documentatie](https://developers.google.com/identity/protocols/oauth2/native-app). De plugin opent tijdelijk een luisterpoort op `127.0.0.1` voor de terugkoppeling en sluit deze na de aanmelding.

**Waarom de brede Drive-scope?** De plugin moet ook bestaande bestanden en bestanden kunnen lezen die jij buiten deze app in de vaultmap toevoegt. De beperktere `drive.file`-scope geeft niet vanzelf toegang tot willekeurige bestanden in zo'n map. Daarom vraagt deze versie brede toegang, terwijl zijn bestandsacties in de code tot de gekozen map worden begrensd. Lees hierover [Google's uitleg over scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Bij een externe app met publicatiestatus **Testing** kunnen refresh tokens na zeven dagen verlopen. Dan is opnieuw aanmelden nodig. Stel de publicatiestatus passend in voor jouw eigen gebruik; voor algemene distributie gelden Google's verificatieregels. Zie [Google's tokenbeleid](https://developers.google.com/identity/protocols/oauth2#expiration). De plugin kan deze Google-regels niet omzeilen.

## 3. Je vault koppelen

1. Maak in **Mijn Drive** een aparte map voor deze vault. Gebruik geen bovenliggende map met andere documenten en niet de hoofdmap van je hele Drive.
2. Open **Instellingen → Drive Vault Sync**.
3. Vul de client-ID in en plak de link of ID van de Drive-vaultmap. Klik **Verbinding opslaan**.
4. Vul de client secret in en klik **Bewaren**.
5. Klik **Aanmelden**. Geef in de systeembrowser toestemming aan je eigen Google-app.
6. Klik **Voorstel bekijken** en daarna **Nu synchroniseren** wanneer de bestandsacties kloppen.
7. Schakel **Automatisch synchroniseren** in. Het standaardinterval is twee minuten. Voor grote vaults kun je een langer interval kiezen.

Het wijzigen van de gekoppelde map zet automatische sync en verwijderingen uit. Dat geeft je gelegenheid de nieuwe vergelijking te bekijken. Bij een volgende start van Obsidian blijft jouw gekozen instelling behouden.

De inhoud van de Drive-map vormt direct de vaultinhoud. Plaats dus `Notitie.md` in die map, niet eerst nog een extra map met de naam van dezelfde vault. Op een tweede pc installeer je de plugin opnieuw, kies je dezelfde Drive-map en meld je lokaal aan. Je kunt daar met een lege vault starten.

## Voortgang tijdens synchroniseren

Zodra een echte ronde of een voorstel begint, verschijnt een compacte popup in Obsidian's meldingengebied. Je kunt ondertussen blijven werken. Je ziet het controleren van je account, inventariseren, vergelijken, downloaden, opnieuw controleren, uploaden en het opslaan van de synchronisatiestatus. Alleen fasen waarin werk is worden getoond.

Tijdens de Drive-inventarisatie toont de popup hoeveel items zijn gelezen en hoeveel mappen zijn gecontroleerd. Het uiteindelijke aantal is dan nog onbekend, dus de balk beweegt zonder percentage. Bij lokale controles en overdrachten is het faseaantal bekend: bijvoorbeeld **12 van 40 bestanden · 30% van deze fase**. De bestandsnaam eronder laat zien welk bestand zojuist is verwerkt of wordt verwerkt. De voortgang telt bestanden; bij een grote bijlage kan de teller blijven staan totdat de overdracht en controles klaar zijn. Er is geen bytepercentage of voorspelde eindtijd.

Het percentage geldt steeds voor de **huidige fase**. Na downloaden kan nog uploaden volgen. De uploadteller wordt na het opnieuw controleren berekend en bevat ook nieuw aangemaakte conflictkopieën. Een overdracht telt pas als voltooid nadat ook het checkpoint is opgeslagen. **Klaar** verschijnt pas na de hele ronde, inclusief het bewaren van de eindstatus.

- **Stoppen** annuleert de lopende ronde; al afgeronde acties en lokale bestanden blijven bewaard.
- **Verbergen** sluit alleen de popup; de synchronisatie gaat door.
- Klik tijdens een ronde op de Drive-status onderaan, nogmaals op **Nu synchroniseren**, of gebruik **Synchronisatievoortgang bekijken** om de popup terug te openen.
- Na succes blijft de samenvatting vijf seconden staan. Bij een fout blijft de melding vijftien seconden staan; de details blijven ook via **Activiteit** beschikbaar. Een gestopte ronde krijgt geen geslaagde eindmelding.

Het afsluitvenster gebruikt dezelfde fase- en bestandsvoortgang, samen met de bestaande resterende wachttijd en overslaanknop. Er opent dan geen extra losse popup.

## Opslaan en synchroniseren bij afsluiten

**Synchroniseren bij afsluiten** staat standaard aan. Het werkt nadat Google gekoppeld is en **Automatisch synchroniseren** is ingeschakeld. Pauzeren pauzeert ook de afsluitsync. Na het kiezen van een nieuwe Drive-map blijft alles dus eerst handmatig totdat je de eerste vergelijking hebt gecontroleerd.

Wanneer je het hoofdvenster van je vault normaal sluit, houdt de plugin het sluiten tijdelijk tegen:

1. Een lopende synchronisatie wordt gestopt en afgewacht; er starten geen twee rondes tegelijk.
2. Open tekstweergaven worden via Obsidian's `TextFileView.save()` lokaal opgeslagen, inclusief de laatste aanslagen die nog op de editorwachttijd stonden.
3. Er volgt een nieuwe synchronisatie, zonder het normale interval af te wachten: eerst Drive-wijzigingen downloaden en conflicten bewaren, daarna lokale wijzigingen uploaden.
4. Zodra dit klaar is, mag Obsidian sluiten. Andere afsluitopdrachten van Obsidian en plugins krijgen hun eigen normale afhandeling.

Het voortgangsvenster toont de resterende wachttijd en heeft een knop **Nu sluiten zonder te wachten**. De standaardlimiet voor het werk van deze plugin is **30 seconden**, inclusief het afwachten van een vorige ronde. Je kunt 5, 15, 30, 60 of 120 seconden instellen. Kleine wijzigingen kunnen snel klaar zijn, maar er is geen gemeten vaste duur: het aantal mappen en bestanden, grote bijlagen en je verbinding bepalen hoeveel tijd de vergelijking en overdracht kosten. De limiet geldt voor deze plugin; Obsidian, het besturingssysteem of andere plugins kunnen afzonderlijk nog moeten opslaan.

Bij geen internet, een fout, handmatig overslaan of het verstrijken van de wachttijd wordt de overdracht afgebroken en gaat het afsluiten verder. Dit wordt niet als een geslaagde Drive-sync geregistreerd. Je lokale bestanden en afgeronde checkpoints blijven bewaard. Bij de volgende start meldt de plugin een onbevestigde afsluitsync; de volgende normale automatische ronde vergelijkt opnieuw. Na een geslaagde ronde verdwijnt die markering.

Een crash, stroomuitval, geforceerd beëindigen via Taakbeheer of een geforceerde Windows-afmelding kan deze afsluitstap overslaan. Obsidian's normale lokale autosave en de periodieke Drive-sync blijven daarom van belang. De plugin is geen los achtergrondproces na het afsluiten.

Het langer tegenhouden van een desktopvenster gebruikt naast de publieke `quit`-taken ook Obsidian's interne Electron-vensterbrug. De afsluitcode is statisch onderzocht in de geïnstalleerde Obsidian 1.14.5; de gebeurtenissen worden geautomatiseerd nagebootst. Er is nog geen volledige afsluitproef met een echte vault en Google-account uitgevoerd. Als de vensterbrug in jouw versie ontbreekt, verschijnt in de instellingen een melding en blijft alleen een poging van maximaal twee seconden over. Gebruik dan **Nu synchroniseren** voordat je sluit.

Om versie 1.0.0 bij te werken: sluit Obsidian en vervang de drie pluginbinaries met het nieuwe pakket, of gebruik opnieuw `Install.ps1`. Je bestaande koppeling en vergelijkingsgeschiedenis blijven behouden. De nieuwe afsluitoptie wordt bij de update standaard ingeschakeld.

## Hoe de vergelijking werkt

| Lokale toestand | Drive-toestand | Actie |
| --- | --- | --- |
| Gelijk aan Drive | Gelijk aan lokaal | Geen inhoudsoverdracht |
| Ongewijzigd | Gewijzigd | Eerst downloaden |
| Gewijzigd | Ongewijzigd | Na de downloadfase uploaden |
| Beide gewijzigd | Verschillende inhoud | Lokale conflictkopie bewaren; Drive-versie downloaden; conflictkopie uploaden |
| Bestand aan één kant nieuw | Ontbreekt aan de andere kant | Kopiëren naar de andere kant |
| Verwijderd | Andere versie gewijzigd | De gewijzigde inhoud herstellen |

Bij de allereerste sync bestaat nog geen vergelijkingsgeschiedenis. Als dezelfde naam dan verschillende inhoud heeft, blijven beide versies bewaard. Er wordt geen winnaar gekozen op basis van de klok van je pc.

Een naamwijziging wordt behandeld als een nieuw pad plus het verdwijnen van het oude pad. Met **Verwijderingen doorgeven uit** kan de oude naam daarom terugkomen. Met de instelling aan wordt de oude, ongewijzigde versie via de prullenbak opgeruimd. Grote verplaatsingen kunnen terecht de beveiliging tegen massaverwijdering activeren.

## Verwijderen en conflicten opruimen

Met **Verwijderingen doorgeven uit** worden bestanden die aan één kant ontbreken teruggehaald. Dit is de standaard. Wil je verwijderingen normaal laten doorwerken, zet de instelling na de eerste gecontroleerde sync aan.

Met de instelling aan worden alleen ongewijzigde bestanden verwijderd. Een ontbrekend Drive-bestand moet aantoonbaar in de Drive-prullenbak staan of onder een ander pad in dezelfde inventaris zijn gevonden. Geen toegang krijgen of een bestand definitief niet kunnen vinden wordt niet als toestemming tot lokaal verwijderen behandeld.

Meer dan tien verwijderingen per ronde worden geblokkeerd. Vanaf een vergelijkingsgeschiedenis van tien bestanden wordt ook een verwijdering van meer dan twintig procent geblokkeerd. Je kunt het voorstel nog wel bekijken. Een reset van de geschiedenis schakelt verwijderen weer uit en is dus geen manier om deze beveiliging stilzwijgend te omzeilen.

Na een conflict kun je de twee notities vergelijken en de gewenste inhoud samenvoegen. Verwijder de overbodige kopie pas daarna. Zolang verwijderen uitstaat, moet je die kopie aan beide kanten opruimen; anders wordt hij opnieuw teruggehaald.

## Herstelkopieën

Vóór het vervangen of verwijderen van bestaande inhoud bewaart de plugin de oude bytes in:

```text
JOUW-VAULT/.drive-vault-sync/recovery/
```

De submappen bevatten de syncsessie, de reden en het oorspronkelijke pad. Het bestand eindigt met een inhoudskenmerk en `.bak`. Via het commando **Herstelkopieën openen** kom je bij deze map. Pauzeer de plugin voordat je een backup terugkopieert en herstel de oorspronkelijke bestandsnaam en extensie.

Herstelkopieën worden niet naar Drive gesynchroniseerd en niet automatisch verwijderd. Ruim oudere exemplaren zelf op nadat je hebt gecontroleerd dat ze niet meer nodig zijn. De plugin gebruikt daarnaast de lokale prullenbak en de Drive-prullenbak. Lokale kopieën zijn geen onafhankelijke backup bij schijfverlies; houd voor belangrijke notities ook een aparte backup bij.

De vergelijkingsgeschiedenis staat in de pluginmap in `sync-state.json`, met het vorige checkpoint in `.bak`. Bij beschadiging stopt de sync. Sluit Obsidian, bewaar de beschadigde status apart en herstel een bekende goede `.bak` naar `sync-state.json`. Wis de geschiedenis niet om een foutmelding te laten verdwijnen zonder de gevolgen te bekijken.

## Wat wordt uitgesloten of begrensd?

- De eigenlijke configuratiemap, ook als die anders heet dan `.obsidian`.
- Alle verborgen bestanden en mappen, waaronder `.git`, `.trash` en de herstelmap.
- De extra relatieve bestanden en mapprefixen die jij invult. De uitsluitingen gebruiken geen wildcards.
- Bestanden boven 100 MiB: de ronde stopt met een melding; ze worden niet stilzwijgend overgeslagen.
- Google Docs, Sheets, Slides, Drive-snelkoppelingen en Shared Drives worden niet ondersteund. Zet gewone `.md`-bestanden en bijlagen in een map in Mijn Drive.
- Lege mappen worden niet apart overgedragen. Mappen met bestanden worden waar nodig aangemaakt.
- Symbolische links en Windows-junctions worden geweigerd. Bestandsnamen moeten op Windows te representeren zijn. Dubbele namen en verschillen die alleen hoofdletters of Unicode-normalisatie betreffen, moeten eerst worden opgelost.
- Er zijn grenzen van 64 mapniveaus, 10.000 mappen en 100.000 bestanden. Deze versie inventariseert elke ronde de hele map en hasht de lokale bestanden; voor zeer grote vaults is dat relatief duur.

Er is geen mobiele versie of los achtergrondproces. Sync vindt plaats zolang Obsidian draait. Op Windows kan het venster wel geminimaliseerd zijn. Na slaapstand of een netwerkstoring wordt later opnieuw vergeleken. Grote uploads kunnen binnen de lopende ronde hervatten; na een herstart wordt een onvoltooide overdracht opnieuw gestart met behoud van het gereserveerde bestands-ID.

De inhoud wordt als gewone bestanden in Drive opgeslagen, zonder extra end-to-endversleuteling. OAuth-tokens en de client secret staan in Obsidian SecretStorage en worden niet in `data.json` geschreven. Het activiteitenvenster bewaart maximaal tweehonderd meldingen in het geheugen en kan bestandsnamen tonen. Er is geen telemetrie of eigen server.

## Problemen oplossen

| Melding/situatie | Wat je doet |
| --- | --- |
| Google-aanmelding verlopen / `invalid_grant` | Meld opnieuw aan; controleer Testing en ingetrokken accounttoegang. |
| Google blokkeert de aanmelding | Controleer Desktop app als clienttype, de Drive API, doelgroep/testgebruiker en de juiste client-ID/secret. |
| Dubbele naam in Drive | Geef één van de bestanden in de webinterface een andere naam; beide inhoudsversies blijven beschikbaar. |
| Bestand ontbreekt zonder bevestigde prullenbakstatus | Controleer Drive-rechten, de gekozen map en definitieve verwijderingen. Herstel zo nodig het bestand. Met **Geschiedenis opnieuw opbouwen** kun je bewust een nieuwe vergelijking beginnen, waarbij automatische sync en verwijderen uitgaan. |
| Een bestand verandert tijdens de sync | De ronde stopt; eerder afgeronde acties blijven geregistreerd. Laat de bewerking afronden en synchroniseer opnieuw. |
| Massaverwijdering geblokkeerd | Bekijk het voorstel. Zet verwijderen uit om de ontbrekende bestanden terug te halen, of voer bedoelde verwijderingen in kleinere groepen uit. |
| Een syncslot blijft staan | Sluit alle Obsidian-processen. Verwijder daarna uitsluitend `.drive-vault-sync/sync.lock` als er werkelijk geen sync meer draait. |
| Bestand groter dan 100 MiB | Verplaats het buiten de vault of voeg het expliciet toe aan de uitsluitingen. |

De instellingen **Afmelden** verwijderen de lokale refresh-tokenkoppeling. Google-toestemming kun je daarnaast intrekken via de [verbonden apps van je Google-account](https://myaccount.google.com/connections).

## Broncode bouwen

Het broncode-ZIP bevat TypeScript, de lockfile en de tests. Gebruik Node.js 22 of nieuwer:

```powershell
npm ci --ignore-scripts
npm run check
```

De build maakt `main.js` en controlehashes. Voor de tests moet je omgeving lokale loopbackverbindingen en tijdelijke junctions binnen de testmap toestaan. Bekijk `ARCHITECTUUR.md` voor de ontwerpkeuzes en `TESTVERSLAG.md` voor wat wel en niet is getest.
