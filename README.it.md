# Claude Usage — estensione GNOME Shell

🇬🇧 [English](README.md) · 🇮🇹 Italiano

Mostra nella barra superiore quanto hai consumato dei limiti d'uso di Claude,
senza dover aprire una sessione Claude Code e digitare `/usage`.

```
 …  ✳ 19% · 2h46   📶 🔋 54%
```

- **`19%`** — consumo della sessione da 5 ore
- **`2h46`** — quanto manca al reset di quella sessione

Passando il mouse sull'indicatore si apre il menu con l'utilizzo settimanale, le
barre di avanzamento e gli **orari esatti di reset nel fuso di Roma**; si
richiude da solo quando il puntatore se ne allontana. Il click sull'indicatore
non fa nulla di proposito: aprire e chiudere è compito del solo passaggio del
mouse, e per chiedere subito un dato nuovo c'è «Aggiorna ora» dentro il menu.

> L'interfaccia è in italiano o in inglese, a scelta nelle preferenze (default:
> italiano). Estensione non ufficiale, non affiliata ad Anthropic.

## Come funziona

Interroga `https://api.anthropic.com/api/oauth/usage`, lo stesso endpoint che
alimenta `/usage` dentro Claude Code, usando il token OAuth che Claude Code
mantiene già in `~/.claude/.credentials.json`.

Il file viene **soltanto letto, mai scritto**: non c'è modo che l'estensione
invalidi il tuo login. Quando il token scade, l'indicatore ingrigisce e mostra
l'ultimo valore noto; appena riapri Claude Code il token si rinnova e un
`FileMonitor` fa ripartire l'aggiornamento da solo. (Del resto, se Claude Code
non gira, il consumo non sta comunque cambiando.)

Un valore noto però non resta noto per sempre. Quando è passato l'orario di reset
della sessione da 5 ore, o quando è semplicemente cambiato il giorno, quella
percentuale non descrive più niente: il pannello torna a `…` e il menu resta
senza barre, invece di continuare a esibire un numero di ieri come se fosse di
adesso.

Gli orari di reset arrivano dall'API in UTC e vengono convertiti esplicitamente
su `Europe/Rome`, con l'offset DST corretto per la data del reset.

Se manca del tutto `~/.claude`, Claude Code non è mai partito su questo
computer, e il menu lo dice («Claude Code non installato»). Se la cartella c'è
ma manca il file delle credenziali, chiede di accedere con Claude Code.

### Non farsi limitare (HTTP 429)

L'endpoint limita le richieste ravvicinate, e ci si arriva molto prima di quanto
suggerisca il solo intervallo di aggiornamento: le richieste partono da tre parti
diverse — il polling, la riscrittura di `.credentials.json` da parte di Claude
Code e il comando «Aggiorna ora».

Passano tutte da un unico punto, che tiene un solo tentativo in programma per
volta: una sorgente può al più anticiparlo, mai aggiungerne uno. Aprire il menu,
invece, **non chiede più niente**: con l'hover succede a ogni passaggio del
mouse, ed è un gesto troppo frequente perché possa costare una richiesta.

- due richieste non sono mai a meno di **60 secondi** l'una dall'altra;
- dopo un 429 si aspetta **5 minuti**, poi 10, poi 15 al massimo — e in quella
  finestra non passa nulla, e il pulsante diventa «Refresh forzato»: cliccarlo
  rifà la richiesta comunque, a tuo rischio (insistere può allungare il blocco);
- l'intervallo di aggiornamento si imposta in minuti, minimo **3**;
- dopo **5 minuti** di sessione inattiva il polling si ferma del tutto e
  riprende, con un aggiornamento immediato, appena torni al computer;
- **a Claude Code fermo non si chiede niente**: vedi sotto.

Il menu, sotto rate limit, dice quanto manca al prossimo tentativo.

> `Retry-After` viene onorato quando è sensato, ma non aspettartelo: il 429 di
> questo endpoint arriva dal bordo Cloudflare e porta `retry-after: 0`, che non
> dice nulla. In quel caso comanda il backoff locale.

#### Chiedere solo quando c'è qualcosa da sapere

Il consumo si muove soltanto mentre Claude Code lavora. A sessione ferma l'API
risponderebbe ogni volta lo stesso numero, e ogni richiesta sarebbe quota
bruciata per nulla — comprese tutte quelle delle ore in cui il computer resta
acceso senza che tu stia facendo niente.

Claude Code riscrive il proprio trascritto in
`~/.claude/projects/<progetto>/<sessione>.jsonl` **a ogni messaggio**: è l'unico
file che cambia di continuo, quindi è il segnale di attività più diretto che ci
sia. `lib/activity.js` ci mette sopra un `FileMonitor` per cartella di progetto
(le 32 più recenti, per non aprire watch inotify a valanga) e si limita a
segnare _quando_ qualcosa è stato toccato: per decidere se interrogare l'API il
file non serve aprirlo. Lo legge, in sola lettura, solo la parte delle
[sessioni](#sessioni-di-claude-code-l-dice-a-che-punto-sei).

Se non si vede attività da **10 minuti**, il poll periodico viene saltato e
riprovato più tardi, senza toccare la rete. Restano invece sempre permessi
l'avvio e «Aggiorna ora», che sono richieste tue.

> Si disattiva dalle preferenze. **Fallo se usi Claude dal browser**: lì non
> c'è nessun trascritto locale da osservare, il consumo cambia senza che questa
> macchina se ne accorga, e il pannello resterebbe su `…` finché non premi
> «Aggiorna ora».

#### Il gate sopravvive all'indicatore

Contenere le richieste **dentro** l'indicatore non basta, perché l'indicatore
non è eterno: la shell lo distrugge e lo ricostruisce a ogni cambio di modalità
di sessione, e dopo il login capita più volte di fila — tre in due minuti, in un
caso misurato. Ogni istanza ripartiva con i contatori a zero e la prima cosa che
faceva era chiedere subito un dato nuovo: era **quella** la raffica che portava
al 429, non il polling.

Perciò l'istante dell'ultima richiesta, la scadenza del backoff, i fallimenti
accumulati e l'ultimo dato buono stanno in GSettings (chiavi `last-request`,
`retry-until`, `backoff-failures`, `cached-usage`, `cached-at`: stato, non
preferenze). Un indicatore appena costruito eredita l'attesa in corso e mostra
subito il valore in cache invece di andarselo a riprendere; il contenimento
sopravvive anche al riavvio della shell.

### Con più schermi

Estensioni come [Multi Monitor
Bar](https://extensions.gnome.org/extension/8236/multi-monitors-bar/) rifanno la
barra sugli schermi non primari, e lì mettono un **pulsante che clona** questo
indicatore: essendo un altro attore, il nostro `hover` non se ne accorgeva, e sul
secondo schermo il menu non si apriva affatto.

L'estensione cerca ora le proprie copie nell'albero della shell — le riconosce
sia dal riferimento all'originale sia, in generale, dal clone che contengono — e
le tratta come l'indicatore stesso: hover, apertura e chiusura automatica
funzionano su ogni schermo, con il menu ancorato alla copia da cui è arrivato il
puntatore. La ricerca si ripete quando cambiano i monitor o quando un'estensione
viene attivata o ricaricata; se non trova copie, non cambia nulla.

### La posizione nella zona va tenuta, non solo impostata

Mettere l'indicatore all'indice scelto è un fatto che dura il tempo che dura:
nella stessa zona continuano ad arrivare altri, e chi si inserisce prima di noi
ci sposta di un posto verso destra. Dopo il login ne arrivano parecchi — le
icone di AppIndicator man mano che i programmi in vassoio partono, gli elementi
della shell rimessi in fila a ogni cambio di modalità di sessione — e ad avvio
finito l'indicatore non stava più dove diceva l'impostazione. Era questo il
«l'ho salvato a 0 e al riavvio lo trovo a destra»: cambiare l'impostazione a
sessione avviata sembrava funzionare solo perché lì la ricreazione arriva dopo
tutti gli altri.

La zona viene quindi sorvegliata: a ogni vicino che compare o sparisce
l'indicatore torna al suo indice (o all'ultimo posto disponibile, se la zona si
è accorciata). Se un'altra estensione rivendicasse lo stesso posto allo stesso
modo, i due se lo scambierebbero all'infinito: dopo una quarantina di
spostamenti in dieci secondi si lascia perdere, perché un indicatore fuori posto
è meglio di un pannello che sfarfalla.

## Sessioni di Claude Code: l'✳ dice a che punto sei

Gli stessi trascritti dicono anche _a che punto_ è un turno, e l'✳ del pannello
lo mostra:

| ✳ | Significa |
|---|---|
| bianco, fermo | nessuna sessione in corso |
| ruota lentamente | Claude sta lavorando |
| **verde** | ha finito — finché non passi il mouse sull'indicatore |
| **verde**, ruota | una chat ha finito, un'altra lavora ancora |
| **arancione**, pulsa | aspetta te — vince su tutto il resto |

Con più chat, nella stessa finestra di VS Code o in finestre diverse, il colore
è quello della più urgente e la rotazione dice che qualcosa sta ancora
lavorando: una chat che finisce accende il verde senza fermare l'✳.

Il menu, sotto i limiti, elenca le **istanze di VS Code**, una riga per
finestra con il nome della cartella aperta: più chat nella stessa finestra
stanno in una riga sola, che racconta la più urgente («fermo da 4 min su Bash»,
«piano da approvare», «finito alle 14:32 · un'altra al lavoro»). Un clic su una
riga porta in primo piano quella finestra; se non è aperta, il clic non fa
niente.

Verde e arancione stanno lontani dal giallo e dal rosso delle soglie di
consumo, così «ha finito» e «aspetta te» non si confondono con «sei al 50%»; il
colore non è l'unico segnale (rotazione, pulsazione) e ha una variante scura
per i pannelli chiari, riconosciuti dal colore del testo che il tema dà al
pannello. La rotazione va a scatti — l'✳ ha simmetria di 45° — per non tenere
la GPU a 60 fps per tutto il tempo in cui Claude lavora.

### Come si capisce

`lib/turns.js`, a ogni modifica di un `.jsonl`, ne legge **soltanto la coda** —
da 64 KB fino a 4 MB, se un risultato di tool molto lungo ha spinto indietro
l'ultimo messaggio — e guarda l'ultimo messaggio del modello:

| Nel trascritto | Stato |
|---|---|
| `stop_reason: "end_turn"` | ha finito |
| `AskUserQuestion` o `ExitPlanMode` senza risultato | aspetta te, subito |
| un altro tool senza risultato, file fermo da 3 minuti | aspetta te (o comando lungo) |
| `Agent` senza risultato | lavora: è un subagent, che scrive altrove |
| `[Request interrupted by user…]` | niente: l'hai fermato tu |

Niente hook, niente righe in `~/.claude/settings.json`: della configurazione di
Claude Code non si tocca nulla, e i trascritti vengono solo letti.

Il prezzo è la terza riga. La finestra in cui Claude Code ti chiede il permesso
per un comando **non lascia traccia nel trascritto**: un `Bash` che aspetta il
tuo «consenti» e un `Bash` che sta compilando da due minuti sono, nel file, la
stessa cosa. Per questo l'arancione arriva solo dopo un'attesa (configurabile,
da 30 secondi a 30 minuti), e il menu dice entrambe le possibilità.

Una sessione riaperta non annuncia un turno di ieri.

Quando chiudi una chat, o VS Code, la sessione sparisce dal menu. Ogni chat
aperta è un processo `claude`, e da `/proc` — anche questo solo letto — si sa in
che cartella gira: il nome della cartella del trascritto in `~/.claude/projects`
è proprio quel percorso, con ogni carattere che non sia una lettera o una cifra
sostituito da `-`. Senza più un processo su quel progetto, le sue sessioni
escono dall'elenco: lo si controlla a ogni tick da 30 secondi e, per non farti
aspettare, un paio di secondi dopo la chiusura di una finestra di VS Code.

Il controllo parte solo se nel menu c'è almeno una sessione — senza, non c'è
niente da togliere — e non lo fa la shell: passare in rassegna /proc vuol dire
aprire qualche centinaio di file, una decina di millisecondi che sul thread che
disegna lo schermo basterebbero a far saltare un fotogramma sui monitor a 120
Hz. Lo fa un `sh` a parte, che scarta i processi dal solo nome (`comm`) e
restituisce cartella e argomenti dei pochi `claude` rimasti in un'unica
risposta asincrona; alla shell resta l'avvio del processo, un paio di
millisecondi. Vale
anche per le sessioni da terminale e per quelle in un Dev Container. Con due
chat sullo stesso progetto, chiuderne una sola non basta a toglierla — i due
processi sono indistinguibili, a meno che uno non sia stato ripreso con
`--resume` — ma chiudere la finestra le toglie entrambe. Le notifiche di sistema ci sono ancora, spente di default:
servono se il pannello resta nascosto, per esempio con una finestra a schermo
intero.

> Il formato dei trascritti è interno a Claude Code e non documentato: se una
> versione futura lo cambia, l'✳ smette di cambiare stato — l'indicatore del
> consumo non ne risente.

## Installazione

Copia-incolla il blocco intero, da qualsiasi directory: `SRC` fa da unico
punto da adattare se sposti il progetto.

```bash
# 0. Percorso del progetto (l'unica riga da cambiare se lo sposti altrove)
SRC=~/Documenti/utilizzo-claudio

# 1. Collega la cartella fra le estensioni dell'utente
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$SRC" ~/.local/share/gnome-shell/extensions/claude-usage@msiliberto.github.io

# 2. Compila lo schema GSettings (obbligatorio)
glib-compile-schemas "$SRC/schemas/"

# 3. Esci e rientra dalla sessione, poi abilita l'estensione
gnome-extensions enable claude-usage@msiliberto.github.io
```

Il `logout` fra il punto 2 e il punto 3 **non è opzionale**: su Wayland non
esiste più il riavvio della shell con `Alt+F2` → `r`, e finché la shell non
rilegge la cartella delle estensioni il comando `enable` risponde
«l'estensione non esiste».

> Non usare `$PWD` al posto di `$SRC`: se lanci il comando dalla home ti ritrovi
> un symlink che punta a `/home/<utente>` invece che al progetto.

## Sviluppo

Collaudo di rete, parsing e fuso orario **senza riavviare la shell**:

```bash
./tools/run-test.sh              # usa Europe/Rome
./tools/run-test.sh UTC          # verifica che il fuso venga davvero applicato
```

> Lo script passa da `tools/run-test.sh` e non direttamente da `gjs` perché il
> terminale di VS Code installato come snap imposta `GIO_MODULE_DIR` su moduli
> GIO incompatibili, che fanno fallire il backend TLS di libsoup. GNOME Shell
> gira fuori dallo snap e non ne è affetto.

Prova dell'interfaccia in una shell separata, senza uscire dalla sessione:

```bash
env -u XDG_DATA_HOME -u GIO_MODULE_DIR -u GSETTINGS_SCHEMA_DIR \
    XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG" CLAUDE_USAGE_DEBUG=1 \
  dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800
```

Due avvertenze imparate sul campo:

- in GNOME 50 l'opzione `--nested` **non esiste più**; senza `--display-server`
  la shell dovrebbe partire annidata, ma dal terminale snap di VS Code non
  riesce ad agganciarsi al compositore e ricade in modalità display server
  (`Failed to take control of the session: EBUSY`). La modalità `--headless`
  aggira il problema e carica comunque tutto il JS;
- va tolta `XDG_DATA_HOME`, altrimenti punta dentro lo snap: la shell leggerebbe
  schemi GSettings obsoleti e **non troverebbe nemmeno** `~/.local/share/gnome-shell/extensions`.

### Diagnostica

Impostando `CLAUDE_USAGE_DEBUG=1` nell'ambiente della sessione, l'estensione
registra l'esito di ogni aggiornamento:

```bash
journalctl --user -f -o cat | grep -i claude-usage
```

Senza la variabile non scrive nulla nel journal.

## Preferenze

`gnome-extensions prefs claude-usage@msiliberto.github.io`

| Impostazione                                 | Default                                 |
| -------------------------------------------- | --------------------------------------- |
| Lingua                                       | italiano (oppure inglese)               |
| Intervallo di aggiornamento                  | 300 s (minimo 180)                      |
| Mostra percentuale / tempo al reset          | attivi                                  |
| Aggiorna solo mentre Claude Code lavora      | attivo                                  |
| Zona e posizione nella barra                 | destra, 0                               |
| Soglia attenzione (giallo) / critica (rosso) | 50% / 80%                               |
| Fuso orario                                  | `Europe/Rome` (vuoto = fuso di sistema) |
| Percorso credenziali                         | vuoto = `~/.claude/.credentials.json`   |

In caso di errore l'intervallo raddoppia a ogni tentativo fino a un massimo di
15 minuti, e torna al valore normale al primo successo. Vedi
[Non farsi limitare (HTTP 429)](#non-farsi-limitare-http-429) per il resto.

## Creare lo zip

```bash
gnome-extensions pack . \
  --schema=schemas/org.gnome.shell.extensions.claude-usage.gschema.xml \
  --extra-source=lib \
  --extra-source=icons \
  -f
```

## Installare lo zip

```bash
# 1. Installa il bundle nella cartella estensioni dell'utente
env -u XDG_DATA_HOME \
  gnome-extensions install --force claude-usage@msiliberto.github.io.shell-extension.zip

# 2. Verifica che sia atterrata dove la shell la cerca davvero
ls -d ~/.local/share/gnome-shell/extensions/claude-usage@msiliberto.github.io

# 3. Esci e rientra dalla sessione (su Wayland non c'è alternativa)

# 4. Abilita
env -u XDG_DATA_HOME \
  gnome-extensions enable claude-usage@msiliberto.github.io
```

L'`env -u XDG_DATA_HOME` **non è opzionale nel terminale di VS Code**: lo snap
imposta `XDG_DATA_HOME=~/snap/code/<rev>/.local/share`, quindi `gnome-extensions
install` estrae l'estensione lì dentro, esce con successo, e GNOME Shell non la
vede mai. Il sintomo è esattamente «l'estensione non esiste» al passo 4, anche
dopo il logout — e se il passo 2 non stampa nulla è successo proprio questo.

Vale per **entrambi** i comandi: anche `enable` risolve la cartella delle
estensioni a partire da `XDG_DATA_HOME`, quindi lanciato dal terminale snap
cerca l'estensione dentro `~/snap/code/<rev>/...` e risponde «l'estensione non
esiste» pur avendola installata correttamente.

Fuori dallo snap (GNOME Terminal, Konsole, una sessione SSH normale)
`XDG_DATA_HOME` è vuota e `env -u` non fa nulla: è innocuo lasciarlo, quindi se
passi lo zip a qualcun altro conviene dargli i comandi già in questa forma,
senza sapere da che terminale li lancerà.

## Pubblicazione su extensions.gnome.org

1. Crea lo zip come sopra (lo schema finisce nello zip come `.xml`: da GNOME 44
   la shell lo compila da sé, e `gschemas.compiled` non va incluso).
2. Caricalo da <https://extensions.gnome.org/upload/> con il tuo account.
3. Segui la revisione dalla pagina dell'estensione: i revisori rispondono lì.

Il campo `version` di `metadata.json` lo riassegna il sito a ogni upload;
quello mostrato agli utenti è `version-name`.

## Licenza

GPL-2.0-or-later, vedi [LICENSE](LICENSE). Estensione non ufficiale, non
affiliata ad Anthropic; Claude è un marchio di Anthropic, PBC.
