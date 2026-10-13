/* Capisce a che punto è un turno di Claude Code leggendo la coda del trascritto.
 *
 * Ogni sessione ha il suo ~/.claude/projects/<progetto>/<sessione>.jsonl, una
 * riga JSON per evento. Un messaggio del modello occupa più righe — una per
 * blocco: ragionamento, testo, chiamata a un tool — che condividono lo stesso
 * `message.id` e portano già scritto lo `stop_reason`. Da lì si distingue:
 *
 *   - `end_turn` (o un altro motivo che non sia `tool_use`): il turno è finito;
 *   - `tool_use` con tutti i `tool_result` arrivati: il modello sta ripartendo;
 *   - `tool_use` con un risultato ancora mancante: Claude Code è fermo su quel
 *     tool. Se è `AskUserQuestion` o `ExitPlanMode` sta di sicuro aspettando
 *     te; per tutti gli altri può aspettare un tuo permesso oppure star
 *     eseguendo un comando lungo, e dal trascritto le due cose sono identiche:
 *     la finestra del permesso non lascia traccia nel file.
 *
 * Il file viene soltanto letto, e solo la coda: i trascritti arrivano a
 * decine di megabyte e quel che serve sta nelle ultime righe. Il formato è
 * interno a Claude Code e non documentato: tutto ciò che non si riconosce
 * viene saltato, e nel dubbio non si notifica niente.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/* Finestre di lettura crescenti: un risultato di tool può essere enorme (un
 * file letto per intero) e spingere il messaggio del modello più indietro. */
const TAIL_SIZES = [64 * 1024, 512 * 1024, 4 * 1024 * 1024];

/* Tool che esistono solo per farti una domanda: aperti = aspetta te. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/* Tool durante i quali lavora un subagent, che scrive in un trascritto suo:
 * quello principale tace anche per molti minuti senza che manchi nulla. */
const DELEGATING_TOOLS = new Set(['Agent', 'Task']);

const READ_DEBOUNCE = 1000; // ms: un messaggio arriva in più righe ravvicinate
const FRESH_WINDOW = 120 * 1000; // ms: oltre, l'evento non è di adesso

/* Quel che Claude Code scrive quando interrompi un turno, o rifiuti un
 * permesso: «[Request interrupted by user]», «… for tool use]». */
const INTERRUPTED = '[Request interrupted';

function isInterruption(content) {
    if (typeof content === 'string')
        return content.startsWith(INTERRUPTED);
    return Array.isArray(content) &&
        content.some(b => b?.type === 'text' && b.text?.startsWith(INTERRUPTED));
}

/**
 * Stato del turno a partire dal testo di coda del trascritto.
 *
 * @param {string} text - ultime righe del file
 * @param {boolean} partial - la prima riga può essere tagliata a metà
 * @returns {object|null} null se nella finestra non c'è un messaggio del modello
 */
export function parseTurn(text, partial) {
    const lines = text.split('\n');
    if (partial)
        lines.shift();

    const results = new Set();
    const tools = [];
    let id = null, stop = null, lastText = null, timestamp = null, cwd = null;

    for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            continue; // riga vuota, o l'ultima ancora in scrittura
        }
        if (entry.isSidechain)
            continue;
        cwd ??= entry.cwd ?? null;

        const content = entry.message?.content;

        if (entry.type === 'user') {
            if (id)
                break; // più indietro del messaggio del modello: altro turno
            if (entry.isMeta)
                continue;
            if (isInterruption(content))
                return {state: 'idle', cwd}; // l'hai fermato tu: non lavora e non aspetta
            const blocks = Array.isArray(content) ? content : [];
            const toolResults = blocks.filter(b => b?.type === 'tool_result');
            if (toolResults.length === 0)
                return {state: 'working', cwd}; // un tuo prompt, o un'interruzione
            for (const b of toolResults)
                results.add(b.tool_use_id);
            continue;
        }

        if (entry.type !== 'assistant')
            continue;

        const messageId = entry.message?.id;
        if (id && messageId !== id)
            break;
        id = messageId;
        stop ??= entry.message?.stop_reason ?? null;
        timestamp ??= entry.timestamp ?? null;

        // Si legge all'indietro: il primo testo trovato è l'ultimo scritto.
        for (const b of Array.isArray(content) ? [...content].reverse() : []) {
            if (b?.type === 'tool_use')
                tools.unshift({id: b.id, name: b.name});
            else if (b?.type === 'text' && lastText === null)
                lastText = b.text;
        }
    }

    if (!id)
        return null;

    const open = tools.filter(t => !results.has(t.id)).map(t => t.name);
    if (open.length > 0)
        return {state: 'tool', id, tools: open, cwd, timestamp};
    if (stop === 'tool_use')
        return {state: 'working', cwd};
    return {state: 'done', id, text: lastText, cwd, timestamp};
}

/** Legge le ultime `size` byte di `file`; risolve [testo, tagliato]. */
function readTail(file, size, cancellable) {
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_LOW, cancellable, (_f, res) => {
            let stream;
            try {
                stream = file.read_finish(res);
            } catch (e) {
                reject(e);
                return;
            }
            const fail = e => {
                stream.close_async(GLib.PRIORITY_LOW, null, null);
                reject(e);
            };

            // Tutto in asincrono: si gira sul thread che disegna lo schermo.
            stream.query_info_async('standard::size', GLib.PRIORITY_LOW, cancellable, (_s, res1) => {
                let offset;
                try {
                    const total = stream.query_info_finish(res1).get_size();
                    offset = Math.max(0, total - size);
                    // Un lseek: non tocca il disco, quindi non blocca.
                    if (offset > 0)
                        stream.seek(offset, GLib.SeekType.SET, cancellable);
                } catch (e) {
                    fail(e);
                    return;
                }
                stream.read_bytes_async(size, GLib.PRIORITY_LOW, cancellable, (_s2, res2) => {
                    try {
                        const bytes = stream.read_bytes_finish(res2);
                        resolve([new TextDecoder().decode(bytes.toArray()), offset > 0]);
                    } catch (e) {
                        reject(e);
                    } finally {
                        stream.close_async(GLib.PRIORITY_LOW, null, null);
                    }
                });
            });
        });
    });
}

/** Stato del turno nel trascritto `file`, allargando la finestra se serve. */
export async function readTurn(file, cancellable = null) {
    for (const size of TAIL_SIZES) {
        const [text, partial] = await readTail(file, size, cancellable);
        const turn = parseTurn(text, partial);
        if (turn || !partial)
            return turn;
    }
    return null;
}

/* --- processi di Claude Code ancora vivi ---
 *
 * Ogni chat aperta — in VS Code, in un terminale, in un Dev Container — è un
 * processo `claude`, che muore quando la chiudi o chiudi l'editor. Da /proc si
 * legge, sempre e solo in lettura, in che cartella gira: la cartella del
 * trascritto in ~/.claude/projects è proprio quel percorso con ogni carattere
 * che non sia una lettera o una cifra sostituito da «-». Il campo `cwd` del
 * trascritto non va bene allo stesso scopo: segue i `cd` della shell di Claude.
 * Chi riprende una sessione porta anche `--resume=<id>` fra gli argomenti.
 *
 * Passare in rassegna /proc vuol dire aprire qualche centinaio di file: pochi
 * millisecondi, ma sul thread che disegna lo schermo bastano a far saltare un
 * fotogramma sui monitor ad alta frequenza. Lo fa quindi un `sh` a parte, che
 * scarta i processi dal solo nome (`comm`, pochi byte) e per i pochi rimasti
 * stampa cartella e argomenti; la shell riceve tutto in una risposta sola. */

const SCAN_SCRIPT = `
for d in /proc/[0-9]*; do
  read -r c < "$d/comm" 2>/dev/null || continue
  case "$c" in claude|node) ;; *) continue ;; esac
  w=$(readlink "$d/cwd" 2>/dev/null) || continue
  printf '%s\\0' "$w"
  cat "$d/cmdline" 2>/dev/null
  printf '\\036'
done
`;
const RECORD_SEPARATOR = '\x1e';

const encodeProjectDir = path => path.replace(/[^A-Za-z0-9]/g, '-');

function isClaudeProcess(argv) {
    return argv.slice(0, 2).some(arg =>
        GLib.path_get_basename(arg) === 'claude' || arg.endsWith('/claude-code/cli.js'));
}

/** Cartelle di progetto, loro percorso reale e id di sessione dall'uscita di SCAN_SCRIPT. */
export function parseProcesses(output) {
    const dirs = new Set();
    const ids = new Set();
    const paths = new Map(); // cartella codificata → cartella aperta in VS Code
    for (const record of output.split(RECORD_SEPARATOR)) {
        const [cwd, ...argv] = record.split('\0');
        if (!cwd || !isClaudeProcess(argv))
            continue;
        dirs.add(encodeProjectDir(cwd));
        paths.set(encodeProjectDir(cwd), cwd);
        for (const arg of argv) {
            if (arg.startsWith('--resume='))
                ids.add(arg.slice('--resume='.length));
        }
    }
    return {dirs, ids, paths};
}

/**
 * Cartelle di progetto (nel formato di ~/.claude/projects) e id di sessione
 * dei processi di Claude Code in esecuzione. Rifiuta se la scansione non
 * riesce: in quel caso non si toglie niente.
 */
export function scanClaudeProcesses(cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['/bin/sh', '-c', SCAN_SCRIPT],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_async(null, cancellable, (_p, res) => {
            try {
                const [, stdout] = proc.communicate_finish(res);
                const bytes = stdout?.toArray() ?? new Uint8Array();
                resolve(parseProcesses(new TextDecoder().decode(bytes)));
            } catch (e) {
                // Annullata da disable(): lo script non deve sopravviverci.
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    proc.force_exit();
                reject(e);
            }
        });
    });
}

const parseTime = timestamp => {
    const ms = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isNaN(ms) ? null : ms;
};

const isFresh = ms => ms !== null && Date.now() - ms < FRESH_WINDOW;

/* Quanto resta in elenco una sessione che non scrive più. Lavorando, il
 * trascritto si muove almeno a ogni tool; un turno che tace da un quarto d'ora
 * è stato chiuso senza lasciare traccia (VS Code chiuso, processo terminato). */
const WORKING_TTL = 15 * 60 * 1000;
const DONE_SEEN_TTL = 30 * 60 * 1000; // finito e già visto: resta come promemoria
const STALE_TTL = 8 * 3600 * 1000; // tetto per tutto il resto
const CLOSE_GRACE = 10 * 1000; // ms in cui una sessione appena mossa non si toglie

const isUrgent = s => s.status === 'asking' || s.status === 'waiting';
const projectDirOf = path => GLib.path_get_basename(GLib.path_get_dirname(path));

/**
 * Tiene lo stato di ogni sessione di Claude Code vista cambiare.
 *
 * Stati: 'working' (lavora, anche eseguendo un tool), 'asking' (domanda o
 * piano da approvare), 'waiting' (fermo su un tool da `waitingDelay()`
 * secondi: un permesso da dare, o un comando lungo), 'done' (turno finito).
 *
 * `onChange()` a ogni cambio di stato; `onEvent(kind, session)` una volta sola
 * all'ingresso in 'done', 'asking' o 'waiting', per chi vuole notificarlo.
 */
export class ClaudeTurnWatcher {
    constructor({onChange, onEvent, waitingDelay}) {
        this._onChange = onChange;
        this._onEvent = onEvent;
        this._waitingDelay = waitingDelay;
        this._sessions = new Map(); // percorso del trascritto → sessione
        this._instancePaths = new Map(); // cartella di progetto → cartella aperta in VS Code
        this._cancellable = new Gio.Cancellable();
    }

    /** Sessioni in elenco, la più urgente per prima. */
    get sessions() {
        const rank = s => {
            if (s.status === 'asking' || s.status === 'waiting')
                return 0;
            if (s.status === 'done' && !s.seen)
                return 1;
            return s.status === 'working' ? 2 : 3;
        };
        return [...this._sessions.values()]
            .filter(s => s.status !== 'idle')
            .sort((a, b) => rank(a) - rank(b) || b.since - a.since);
    }

    /**
     * Lo stato da mostrare nel pannello: `status` è il più urgente fra tutte
     * le sessioni, `busy` dice se qualcuna sta ancora lavorando — un turno
     * finito non deve far sembrare fermo chi lavora ancora.
     */
    get summary() {
        return summarize(this.sessions);
    }

    /**
     * Le sessioni raggruppate per istanza di VS Code, cioè per cartella di
     * progetto: più chat nella stessa finestra sono una riga sola. Il nome è
     * quello della cartella in cui gira il processo `claude` — la cartella
     * aperta nella finestra — e, finché non lo si conosce, quello del `cwd`
     * del trascritto.
     */
    get instances() {
        const groups = new Map();
        for (const s of this.sessions) {
            const key = projectDirOf(s.path);
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(s);
        }
        return [...groups].map(([key, sessions]) => {
            const cwd = this._instancePaths.get(key) ?? sessions[0].cwd;
            return {
                key, cwd, sessions,
                name: cwd ? GLib.path_get_basename(cwd) : 'Claude Code',
                ...summarize(sessions),
            };
        });
    }

    /** L'istanza a cui appartiene `session`. */
    instanceFor(session) {
        const key = projectDirOf(session.path);
        return this.instances.find(i => i.key === key) ?? null;
    }

    /** C'è un'istanza di cui non si conosce ancora la cartella aperta. */
    get hasUnnamedInstances() {
        for (const path of this._sessions.keys()) {
            if (!this._instancePaths.has(projectDirOf(path)))
                return true;
        }
        return false;
    }

    /** Hai guardato il menu: i turni finiti non sono più una novità. */
    markSeen() {
        let changed = false;
        for (const s of this._sessions.values()) {
            if (s.status === 'done' && !s.seen) {
                s.seen = true;
                s.seenAt = Date.now();
                changed = true;
            }
        }
        if (changed)
            this._onChange?.();
    }

    /** Toglie le sessioni che non dicono più niente; da chiamare ogni tanto. */
    prune() {
        const now = Date.now();
        let changed = false;
        for (const [path, s] of this._sessions) {
            const quiet = now - s.changedAt;
            const expired =
                s.status === 'idle' ||
                (s.status === 'working' && quiet > WORKING_TTL) ||
                (s.status === 'done' && s.seen && now - s.seenAt > DONE_SEEN_TTL) ||
                quiet > STALE_TTL;
            if (expired && !s.readId) {
                this._clearWait(s);
                this._sessions.delete(path);
                changed ||= s.status !== 'idle';
            }
        }
        if (changed)
            this._onChange?.();
    }

    /** C'è almeno una sessione: solo allora vale la pena cercarne i processi. */
    get hasSessions() {
        return this._sessions.size > 0;
    }

    /**
     * Toglie le sessioni il cui processo non c'è più: hai chiuso la chat, o
     * VS Code. Una sessione che si è appena mossa resta comunque, perché il
     * suo processo può non essere ancora partito o non ancora visibile.
     */
    dropClosed(live) {
        if (!live)
            return;
        let changed = false;
        for (const [dir, path] of live.paths ?? []) {
            if (this._instancePaths.get(dir) !== path) {
                this._instancePaths.set(dir, path);
                changed = true;
            }
        }
        const now = Date.now();
        for (const [path, s] of this._sessions) {
            if (now - s.changedAt < CLOSE_GRACE)
                continue;
            const projectDir = projectDirOf(path);
            if (live.dirs.has(projectDir) || live.ids.has(s.id))
                continue;
            if (s.readId)
                GLib.Source.remove(s.readId);
            this._clearWait(s);
            this._sessions.delete(path);
            changed ||= s.status !== 'idle';
        }
        if (changed)
            this._onChange?.();
    }

    /** Da chiamare a ogni modifica di un file nelle cartelle di progetto. */
    fileChanged(file) {
        const path = file?.get_path();
        if (!path?.endsWith('.jsonl'))
            return;

        let session = this._sessions.get(path);
        if (!session) {
            session = {
                path, id: GLib.path_get_basename(path).replace(/\.jsonl$/, ''), cwd: null, status: 'idle', tools: [],
                since: Date.now(), changedAt: Date.now(), seen: true, seenAt: 0,
                key: null, announced: null, readId: 0, waitId: 0,
            };
            this._sessions.set(path, session);
        }
        session.changedAt = Date.now();

        // Il file si è mosso: chi era fermo non lo è più.
        this._clearWait(session);

        if (session.readId)
            GLib.Source.remove(session.readId);
        session.readId = GLib.timeout_add(GLib.PRIORITY_LOW, READ_DEBOUNCE, () => {
            session.readId = 0;
            readTurn(file, this._cancellable)
                .then(turn => this._onTurn(session, turn))
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'claude-usage: trascritto non leggibile');
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._cancellable.cancel();
        for (const session of this._sessions.values()) {
            if (session.readId)
                GLib.Source.remove(session.readId);
            this._clearWait(session);
        }
        this._sessions.clear();
        this._onChange = null;
        this._onEvent = null;
    }

    _onTurn(session, turn) {
        if (!this._onChange || !turn)
            return;

        session.cwd = turn.cwd ?? session.cwd;
        const at = parseTime(turn.timestamp);

        if (turn.state === 'done') {
            const key = `${turn.id}:done`;
            if (session.key === key)
                return; // righe di servizio dopo la fine: è lo stesso turno, già visto o no
            // Una sessione vecchia riaperta non annuncia un turno di ieri.
            const fresh = isFresh(at);
            this._set(session, 'done', {since: at ?? Date.now(), seen: !fresh, tools: [], text: turn.text},
                key, fresh);
            return;
        }

        if (turn.state !== 'tool') {
            this._set(session, turn.state, {tools: []});
            return;
        }

        if (turn.tools.some(name => ASKING_TOOLS.has(name))) {
            const key = `${turn.id}:asking`;
            if (session.key === key)
                return;
            this._set(session, 'asking', {since: at ?? Date.now(), tools: turn.tools},
                key, isFresh(at));
            return;
        }

        this._set(session, 'working', {tools: turn.tools});

        if (turn.tools.every(name => DELEGATING_TOOLS.has(name)))
            return;

        session.waitId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, this._waitingDelay(), () => {
            session.waitId = 0;
            this._set(session, 'waiting', {since: session.changedAt}, `${turn.id}:waiting`);
            return GLib.SOURCE_REMOVE;
        });
    }

    /* `key` identifica l'evento, così lo stesso turno non si annuncia due
     * volte; `announce` è falso per gli eventi vecchi, che si registrano soltanto. */
    _set(session, status, fields, key = null, announce = true) {
        if (status !== session.status)
            session.since = Date.now();
        session.status = status;
        session.seen = status !== 'done';
        Object.assign(session, fields);
        session.key = key;

        if (key && announce && key !== session.announced) {
            session.announced = key;
            this._onEvent?.(status, session);
        }
        this._onChange?.();
    }

    _clearWait(session) {
        if (session.waitId) {
            GLib.Source.remove(session.waitId);
            session.waitId = 0;
        }
    }
}

/* Lo stato più urgente di un gruppo di sessioni (aspetta te > finito e non
 * ancora visto > lavora > finito e visto) e se qualcuna lavora ancora. */
function summarize(sessions) {
    const busy = sessions.some(s => s.status === 'working');
    let status = 'idle';
    if (sessions.some(isUrgent))
        status = 'waiting';
    else if (sessions.some(s => s.status === 'done' && !s.seen))
        status = 'done';
    else if (busy)
        status = 'working';
    return {status, busy};
}
