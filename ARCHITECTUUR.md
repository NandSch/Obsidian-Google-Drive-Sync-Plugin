# Ontwerp en synchronisatiepipeline

## Doel en harde volgorde

Dit is een directe synchronisatie tussen een lokale Obsidian-vault en één map in Mijn Drive. Google blijft gewone bestanden met een herkenbare mappenstructuur bevatten. De client heeft geen centrale tussenserver en geen eigen cloud-database nodig.

De uitvoering volgt steeds deze volgorde:

```text
Start / lokale wijziging / interval / focus / afsluiten
                    |
                    v
Lokaal exclusief slot + status opnieuw lezen
                    |
                    v
Google-account, gekoppelde map en uploadjournaal controleren
                    |
                    v
Volledige Drive-inventaris + lokale inhoudshashes
                    |
                    v
Namen, ontbrekende IDs en bestandsstructuur controleren
                    |
                    v
Driewegvergelijking: lokaal / Drive / vorige baseline
                    |
                    v
Voorstel óf beveiligingen tegen massaverwijdering
                    |
                    v
ALLE downloads en conflictkopieën afronden
                    |
                    v
Bevestigde lokale verwijderingen naar prullenbak
                    |
                    v
Lokale wijzigingen en conflictkopieën uploaden
                    |
                    v
Bevestigde Drive-verwijderingen naar prullenbak
                    |
                    v
Laatste succes registreren + slot vrijgeven
```

Wanneer een download, controle of lokale schrijfactie in de eerste fase mislukt, begint de uploadfase niet. De hele vault is geen enkele transactie: reeds afgeronde bestandsacties blijven bestaan en krijgen checkpoints. Een fout aan het einde draait eerdere geslaagde acties niet terug.

## Componenten

| Bestand | Verantwoordelijkheid |
| --- | --- |
| `src/main.ts` | Obsidian-levenscyclus, scheduler, instellingen, opdrachten, status en voorstelvenster |
| `src/close.ts` | Begrensde afsluitcoördinatie tussen native venstergebeurtenissen en Obsidian-quit-taken |
| `src/progress.ts` | Voortgangsgebeurtenissen, fasen en beschrijvingen met aantallen per fase |
| `src/progress-view.ts` | Herbruikbaar voortgangspaneel en niet-blokkerende Obsidian-notificatie |
| `src/model.ts` | Datatypen, padregels, pure driewegplanner en verwijderingsgrenzen |
| `src/engine.ts` | De vaste fasering, conflictbehoud en checkpoints |
| `src/drive.ts` | Drive-inventaris, versiecontroles, idempotente aanmaak, uploadblokken en prullenbak |
| `src/local.ts` | Obsidian Vault-API, lokale inhoudscontroles, editorcontrole en herstelkopieën |
| `src/auth.ts` | Browser-OAuth, PKCE, statecontrole, tokenvernieuwing en SecretStorage |
| `src/http.ts` | HTTPS, begrensde antwoorden, timeouts, annulering en vertraging |
| `src/storage.ts` | Atomische statusvervanging, validatie, backups en processlot |

Het domeinmodel heeft geen Obsidian- of netwerkafhankelijkheden. De engine werkt tegen twee kleine interfaces; dezelfde pipeline kan daardoor worden getest met gecontroleerde fouten en gelijktijdige veranderingen.

## Voortgang vanaf 1.2.0

De engine publiceert optionele voortgangsgebeurtenissen op de echte fasegrenzen. De lokale scanner meldt het aantal gehashte bestanden met een vooraf getelde noemer. De Drive-scanner meldt gelezen items na iedere pagina en gecontroleerde mappen; het totale aantal is bij recursieve inventarisatie nog onbekend. Die fase heeft daarom een onbepaalde voortgangsbalk.

Download-, upload- en prullenbakfasen melden het huidige pad en het aantal bevestigde bestanden. Een teller verhoogt pas na de bijbehorende statuscheckpoint. De uploadnoemer wordt berekend na de lokale herscan en omvat aangemaakte conflictkopieën. De balk vertegenwoordigt de huidige fase en is geen geschat totaalpercentage. Grote bestanden kunnen tijdens hun overdracht dezelfde teller houden; er is geen claim van voortgang op byteniveau.

De popup gebruikt een publieke `Notice` met duur nul en een `DocumentFragment` met tekstvelden en een native HTML-progress-element. De view toont geen HTML uit bestandsnamen of fouten. Het paneel is ook bruikbaar in het bestaande afsluitvenster. Knoppen houden hun klik binnen de popup: Stoppen annuleert via de bestaande controller; Verbergen sluit alleen de notificatie. Een statusklik of de voortgangsopdracht opent de laatste voortgang opnieuw. Het openen van een popup verplaatst de editorfocus niet.

De melding gebruikt afzonderlijke regels voor het buitenste `.notice`-oppervlak en de berichtinhoud, zodat een thema geen dubbele rand of donkere achtergrond binnen een lichte popup veroorzaakt. Inhoud gebruikt `--background-primary`, `--text-normal`, `--text-muted`, `--background-modifier-border` en `--interactive-accent`. Het afsluitpaneel heeft een begrensde breedte en hoogte met interne scrolling. Alle inhoud mag krimpen en lange paden wrappen; de flexibele knoppen wikkelen naar een volgende regel.

Snelle updates worden in de view begrensd tot circa één per 120 milliseconden; een fasewissel en de laatste teller van een fase worden meteen getoond. De laatst ontvangen toestand blijft beschikbaar voor heropenen. Succes wordt pas gemeld nadat de engine én de afsluitmarkering zijn afgehandeld. Fouten en annulering krijgen een afzonderlijke eindtoestand. Nieuwe rondes en pluginuitschakeling ruimen oude meldingstimers op. Een mislukte observer onderbreekt de synchronisatie niet.

## Afsluitpipeline vanaf 1.1.0

Een asynchrone `onunload()` is geen betrouwbare gelegenheid om nog te uploaden. De plugin installeert tijdens normaal gebruik een native `close`-listener op het hoofdvenster en een publieke Workspace-`quit`-taak. De lifecyclecode is statisch gecontroleerd in `main.js` en `app.js` van de lokale Obsidian 1.14.5-ASAR: de native venstersluiting markeert het venster als sluitend en plant na drie seconden `destroy()`, tenzij het oorspronkelijke close-event `defaultPrevented` is. De renderer vuurt `quit` af en wacht op geregistreerde taken. Dat zijn twee afzonderlijke lagen.

Daarom markeert de listener het native event met `preventDefault()`, terwijl de quit-taak de renderer laat wachten. De coördinator werkt bij beide aankomstvolgordes en deelt één promise tussen herhaalde sluitverzoeken. Als `quit` heeft plaatsgevonden, sluit de plugin niet zelf vroegtijdig: Obsidian wacht dan eerst op **alle** quit-taken. Als native annulering verhinderde dat `quit` plaatsvond, vraagt de plugin na zijn werk eenmaal een gewone sluiting aan. Die mag door en krijgt Obsidian's normale opslagafhandeling. De plugin wijzigt geen globale `onbeforeunload`-handler en roept geen `destroy()` aan.

Tijdens de afsluitronde staat de scheduler stil en blokkeert het voortgangsvenster nieuwe muisinvoer naar de editor. De vorige netwerkronde wordt geannuleerd en afgewacht. Daarna worden open `TextFileView`-instanties opgeslagen, gevolgd door een nieuwe pull-first vergelijking die de normale cooldown omzeilt. Niet-tekstweergaven van andere plugins houden hun eigen Obsidian-opslagverantwoordelijkheid.

Eén klok begrenst het hele pluginwerk, standaard op dertig seconden. Timeout of overslaan annuleert het signaal en eventuele lopende aanvragen. Te laat binnenkomend succes kan de afsluituitslag niet vervangen. Editorbewaring en normale filesystemoperaties worden niet midden in een syscall onderbroken; na een annulering begint de afsluitpipeline geen volgende fase. Andere plugins en Obsidian kunnen hun eigen afsluitwerk hebben buiten deze tijdslimiet.

Een kleine lokale `close-sync.json` in de pluginmap krijgt vooraf een onbevestigde markering. Alleen een bevestigde afsluitsync of een later geslaagde echte sync wist die. Preview wist niets. De markering bevat geen tokens of notitie-inhoud en valt onder de uitgesloten configuratiemap. Fouten worden bij een volgende start zichtbaar. Bij uitschakelen van de plugin worden listeners en timers opgeruimd en wordt geen nieuwe venstersluiting gestart.

`window.electronWindow` is een interne, versiegevoelige brug. Bij ontbreken ervan is de quit-taak begrensd op twee seconden en toont de instelling een waarschuwing. Geforceerd beëindigen, OS-shutdown, updates die geforceerd herstarten en crashes blijven buiten een gegarandeerde afhandeling. Het normale sluiten van het hoofdvenster is het beoogde pad. Het sluiten van slechts een los notitievenster start geen volledige afsluitsync.

Onderzoeksbronnen: de [publieke Obsidian-API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts), [Electron BrowserWindow-close](https://www.electronjs.org/docs/latest/api/browser-window#event-close) en de eigen implementatiebeschrijving van [Close Reflect](https://github.com/lmce72/obsidian-close-reflect). Er is geen code uit die plugin overgenomen. De lokale ASAR-inspectie is statisch bewijs, geen uitgevoerde eindgebruikertest. Een extra inspectie van de bootstrap-ASAR meldde een integriteitsverschil bij een uitgepakt native onderdeel; dat onderdeel is niet uitgevoerd of gebruikt als bewijs voor de afsluitfunctie. De relevante bronpassages komen uit het gecachete 1.14.5-applicatiearchief.

## Baseline en conflicten

Per pad wordt alleen het bekende Drive-ID en de laatst verzoende inhoudshash opgeslagen. De vergelijking is inhoudelijk en gebruikt MD5 om aan te sluiten op Drive's checksum van gewone bestanden. MD5 is hier een hulpmiddel voor wijzigingsdetectie, geen digitale handtekening of bescherming tegen een kwaadwillende partij die bewust hashbotsingen construeert.

Lokaal gewijzigd met ongewijzigd Drive-bestand betekent uploaden. Ongewijzigd lokaal met gewijzigd Drive-bestand betekent downloaden. Als beide afwijken, wordt de lokale versie eerst veilig gekopieerd. De Drive-versie wordt daarna de versie onder de oorspronkelijke naam. De aparte lokale conflictkopie wordt in de uploadfase meegenomen. Er is geen automatische tekstmerge die mogelijk inhoud weglaat.

Conflictkopienamen zijn deterministisch op basis van het lokale inhoudskenmerk. Een reeds bestaande identieke kopie kan opnieuw worden gebruikt; afwijkende inhoud onder dezelfde conflictkopienaam blokkeert de actie. Daarnaast wordt de oorspronkelijke inhoud als herstelbestand met `fsync` weggeschreven.

Klokverschillen bepalen de winnaar niet. Een state-reset kiest bij afwijkende inhoud opnieuw voor beide versies en schakelt verwijderen en automatische sync uit.

## Inventarisatie en paden

De client loopt de ingestelde Drive-map paginagewijs en recursief af. Ieder bestand moet een eenduidig pad hebben. Er zijn controles op dubbele namen, naamverschillen die op Windows samenvallen, onverwachte ouders, onvolledige lijsten, cycli, niet-representeerbare namen en Google-documenttypen zonder gewone binaire inhoud.

Een onvindbaar eerder bekend Drive-ID kan ook betekenen dat rechten zijn ingetrokken. Daarom wordt een dergelijke fout niet omgezet naar een verwijdering. Alleen aantoonbare prullenbakstatus of een gevonden verplaatsing binnen dezelfde inventaris maakt een verwijderactie mogelijk. Kort vóór een mutatie worden de relevante versie, maplocatie en toegang opnieuw gecontroleerd.

Lokale paden worden relatief gevalideerd en mogen de vault niet verlaten. Reparsepunten, symlinks en junctions in het gecontroleerde pad worden geweigerd. Configuratie en verborgen inhoud worden aan beide kanten vóór inhoudsoverdracht uitgesloten.

Sinds 1.1.1 verwijdert de lokale inventaris eerst uitsluitend het object uit `Vault.getRoot()` uit de lijst van `getAllLoadedFiles()`. Dit Obsidian-hoofdmapobject kan pad `/` hebben en vertegenwoordigt de vault zelf. Het is geen over te dragen map of bestand. Alle overige objecten doorlopen de bestaande uitsluitingen en strikte padvalidatie. De regressietests bevatten het hoofdmapobject ook standaard in de nagebootste Obsidian-bestandslijst.

De inventaris is bewust volledig en zonder wijzigingscursor. Een lokale cursor die verkeerd wordt verwerkt kan blijvende blinde vlekken veroorzaken bij verplaatsingen en veranderde rechten. De keerzijde van een volledige scan is het aantal mapaanvragen en lokale hashes. Het interval is instelbaar; er is geen claim dat dit de efficiëntste oplossing voor honderdduizenden documenten is.

## Netwerk en concurrerende schrijvers

Het bestandsprotocol gebruikt de nog gedocumenteerde **Drive API v2** omdat deze `etag` als expliciet resourceveld aanbiedt. Lees- en schrijfvoorwaarden gebruiken die ETag; een `412` stopt de oude actie. Bestanden krijgen een nieuwere Drive-revisie bij inhoudsupdates. De accountidentiteit wordt via Drive API v3 opgevraagd. Zie de [v2-bestandsresource](https://developers.google.com/workspace/drive/api/reference/rest/v2/files) en [files.update](https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update).

Vóór het overschrijven van Drive-inhoud wordt ook die oude inhoud lokaal als herstelkopie bewaard. Een upload wordt gecontroleerd op ID, inhoudshash, naam en oudermap. Bij een download worden de verwachte ETag en inhoud vóór/na de overdracht gecontroleerd, evenals het ontvangen aantal bytes.

Kleine uploads gebruiken multipart. Boven 5 MiB worden hervatbare sessies en blokken van maximaal 8 MiB gebruikt, een veelvoud van 256 KiB. Na een verloren antwoord vraagt de client de serverstatus op en baseert de volgende offset op het bevestigde bereik. Een verloren laatste antwoord kan dus als geslaagde upload worden herkend. Zie [Google's uploadprotocol](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Leesaanvragen en statusprobes krijgen begrensde herhalingen met oplopende vertraging en willekeurige spreiding. Een autorisatiefout kan één tokenvernieuwing veroorzaken. Gewone mutaties worden niet blind herhaald na een onduidelijk antwoord. De huidige hervatbare sessie staat in het geheugen: na een procesherstart kan opnieuw uploaden nodig zijn; het aanmaak-ID blijft wel bewaard.

De applicatie beperkt netwerkbestemmingen tot Google HTTPS-eindpunten, volgt geen willekeurige redirects en controleert het ontvangen uploadsessieadres voordat daar een token naartoe gaat. OAuth gebruikt daarnaast uitsluitend de systeem-browser naar Google's aanmeldpagina en een lokale terugkoppeling.

Er is geen globale Drive-maptransactie of centrale lockserver. ETags, hercontroles, versiegeschiedenis en herstelkopieën beperken de risico's per bestand. Gelijktijdige aanmaak van dezelfde naam op meerdere pc's kan twee Drive-IDs opleveren. De plugin detecteert dit en stopt met beide bestanden intact. De gebruiker moet dan één versie hernoemen. Dit is een bewuste grens; er wordt geen bestand willekeurig weggegooid om het conflict automatisch op te ruimen.

## Crashherstel en idempotentie

Voor een nieuw bestand of nieuwe map wordt eerst een Google-ID gereserveerd. Dat ID, pad, ouder-ID en de bedoelde inhoudshash worden duurzaam in het uploadjournaal geschreven vóór de aanmaakaanvraag.

Bij een onderbreking zoekt de volgende ronde eerst het gereserveerde ID op. Als de inhoud overeenkomt met de bedoelde upload, wordt die upload als baseline hersteld. Als de inhoud afwijkt, wordt geen geslaagde baseline verondersteld: het kan een onvolledige aanmaak of een latere externe bewerking zijn. De planner bewaart afwijkende lokale en externe versies dan als een conflict. Als het ID nog niet bestaat, blijft het gereserveerd voor een volgende poging. Er wordt niet zomaar een nieuw ID gekozen na een verloren antwoord.

Wijzigt de lokale inhoud terwijl een onzekere aanmaak nog niet kan worden bevestigd, dan stopt de client met een melding. Het blijft onveilig om in die situatie de oorspronkelijke bedoeling van het journaal te overschrijven. Herstel de bedoelde lokale versie of kies bewust voor een nieuwe koppeling.

De status wordt via een tijdelijk bestand, `fsync` en rename vervangen. Het vorige checkpoint blijft in `.bak`. Een ongeldige of onbekende statusschema-versie blokkeert de synchronisatie. Hetzelfde geldt wanneer de hoofdstatus ontbreekt terwijl er nog een backup ligt. Er wordt geen stilzwijgende nieuwe baseline opgebouwd.

Een exclusief lokaal lockbestand verhindert overlappende rondes van vensters op dezelfde pc. Het bevat een proces-ID en een willekeurige eigenaarwaarde. Een slot van een aantoonbaar beëindigd proces kan worden hersteld. Onleesbare sloten en een nog bestaand proces worden conservatief behandeld. Verschillende pc's gebruiken geen gedeeld lockbestand.

## Lokale schrijfbescherming en grenzen

Voor gewone tekst gebruikt de adapter `Vault.process` om de verwachte inhoud te controleren binnen de Obsidian-lees/schrijfoperatie. Ook open Markdown-editors worden gecontroleerd op nog niet opgeslagen inhoud; normale CRLF/LF-verschillen gelden niet als een nieuwe bewerking.

Voor binaire bestanden is er in de gebruikte publieke Obsidian-API geen overeenkomstige atomische compare-and-swap. Daarom worden de huidige bytes gecontroleerd, duurzaam geback-upt, vlak vóór schrijven opnieuw gelezen en na schrijven gecontroleerd. Dit is geen absolute blokkade tegen een extern programma dat op precies dat moment hetzelfde binaire bestand schrijft. Die beperking blijft bestaan en moet niet als volledige transactieveiligheid worden voorgesteld.

Verwijderen betekent prullenbak, niet een permanente API-delete. De verwijderingsgrens telt beide richtingen bij elkaar op en wordt vóór de eerste inhoudsmutatie toegepast. Gewijzigde bestanden worden bij een verwijder/aanpas-conflict hersteld. Herstelkopieën worden niet automatisch opgeruimd.

## Privacy en toegang

De plugin vraagt de volledige Drive-scope om ook buiten de app aangemaakte bestanden in de gekozen map te zien. Dit is bredere toestemming dan één map. De client beperkt zijn reguliere bestandsacties tot de ingestelde root en controleert de ouderketens, maar het OAuth-token heeft technisch de bredere Google-bevoegdheid.

Refresh tokens en de client secret staan uitsluitend in Obsidian SecretStorage. Het data-bestand bevat alleen de secretverwijzing en niet de tokenwaarde. Account-ID en root-ID worden aan de baseline gebonden om te voorkomen dat een andere aanmelding onbedoeld als de oude synchronisatiepartner wordt gebruikt.

Er is geen eigen end-to-endversleuteling, server of telemetrie. Een activiteitenlijst in het geheugen bewaart bestandsnamen en foutmeldingen. Een broncode-audit en eigen OAuth-project blijven mogelijk doordat alle runtimecode is meegeleverd.

## Validatiegrens

De unit- en integratietests omvatten de planner, de hele engine, een nagebootste Drive-API, echte lokale bestandsacties met een Obsidian-testdouble, statusbestanden, Windows-junctions en een echte lokale OAuth-callback met nagebootste tokenserver.

De huidige versie is niet getest tegen een aangemeld live Google-account en niet binnen een draaiende Obsidian-app met een echte gebruikersvault. Vooral servergedrag rond ETags, hervatbare sessies, rechten en het werkelijke Obsidian-editorleven moet daarom als eerste met een kleine proefvault worden gevalideerd. Het testverslag maakt die grens expliciet.
