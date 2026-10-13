/* Lingua dell'interfaccia: italiano o inglese, scelta nelle preferenze.
 *
 * Non gettext: quello segue la lingua del sistema, qui la si sceglie a mano.
 * Le stringhe italiane fanno da chiave, come in gettext, così il codice resta
 * leggibile e l'italiano non ha bisogno di una tabella. I segnaposto sono
 * numerati — {0}, {1} — perché l'inglese possa cambiarne l'ordine.
 *
 * Non dipende da St né da Gtk: lo usano sia l'estensione sia prefs.js.
 */

export const LANGUAGES = ['it', 'en'];

const EN = {
    // --- pannello e menu ---
    'Sessione (5h)': 'Session (5h)',
    'Settimanale': 'Weekly',
    'Settimanale (Opus)': 'Weekly (Opus)',
    'Settimanale (Sonnet)': 'Weekly (Sonnet)',
    'nessun reset programmato': 'no reset scheduled',
    'reset {0} · tra {1}': 'resets {0} · in {1}',
    'Sessioni': 'Sessions',
    "{0} · un'altra al lavoro": '{0} · another one working',
    '{0} · altre {1} al lavoro': '{0} · {1} others working',
    'meno di un minuto': 'less than a minute',
    '{0} min': '{0} min',
    '{0} s': '{0} s',
    'Aspetta te: piano da approvare · da {0}': 'Waiting for you: plan to approve · for {0}',
    'Aspetta te: ti ha fatto una domanda · da {0}': 'Waiting for you: asked you a question · for {0}',
    'Fermo da {0} su {1}\npermesso da dare, o comando ancora in corso':
        'Stuck for {0} on {1}\npermission to grant, or command still running',
    'Finito alle {0}': 'Finished at {0}',
    'Sta lavorando · {0}': 'Working · {0}',
    'Sta lavorando': 'Working',
    'Aggiorna ora': 'Refresh now',
    'Refresh forzato': 'Force refresh',
    'Impostazioni': 'Settings',
    'Piano: {0}': 'Plan: {0}',
    'Ultimo dato {0} non più valido — in attesa di un aggiornamento':
        'Last data from {0} no longer valid — waiting for an update',
    'Claude Code non installato': 'Claude Code not installed',
    'Credenziali non trovate — accedi con Claude Code': 'Credentials not found — log in with Claude Code',
    'Token scaduto — apri Claude Code per rinnovarlo': 'Token expired — open Claude Code to renew it',
    'Troppe richieste — riprovo fra {0} (ultimo: {1})': 'Too many requests — retrying in {0} (last: {1})',
    'Aggiornamento non riuscito (ultimo: {0})': 'Update failed (last: {0})',
    'Ultimo dato noto delle {0} — aggiornamento in attesa': 'Last known data from {0} — update pending',
    'Caricamento…': 'Loading…',
    'Aggiornato alle {0}': 'Updated at {0}',

    // --- notifiche ---
    'Claude ha finito': 'Claude has finished',
    'Turno completato': 'Turn completed',
    'Claude aspetta te': 'Claude is waiting for you',
    'Il piano attende la tua approvazione': 'The plan is waiting for your approval',
    'Ti ha fatto una domanda': 'It asked you a question',
    'Claude è fermo da {0}': 'Claude has been stuck for {0}',
    'In attesa su {0}: ti chiede un permesso, oppure il comando è ancora in corso':
        'Waiting on {0}: it is asking for permission, or the command is still running',

    // --- preferenze ---
    'Lingua': 'Language',
    "Lingua dell'interfaccia": 'Interface language',
    'Italiano': 'Italiano',
    'English': 'English',
    'Aggiornamento': 'Updates',
    ["L'estensione legge soltanto ~/.claude/.credentials.json: non lo modifica mai. " +
        "Fuori dall'intervallo il dato si chiede solo con «Aggiorna ora», nel menu; " +
        'con la sessione inattiva il polling si ferma del tutto.']:
        'The extension only reads ~/.claude/.credentials.json: it never modifies it. ' +
        'Outside the interval, data is only requested with «Refresh now» in the menu; ' +
        'while the session is idle polling stops completely.',
    'Intervallo di aggiornamento': 'Refresh interval',
    "Minuti fra due interrogazioni dell'API (minimo 3): intervalli brevi rischiano il rate limit":
        'Minutes between two API queries (minimum 3): short intervals risk the rate limit',
    'Aggiorna solo mentre Claude Code lavora': 'Only refresh while Claude Code is working',
    ['A sessione ferma il consumo non cambia: rilevato dai trascritti in ~/.claude. ' +
        'Disattivalo se usi Claude dal browser']:
        'With the session idle usage does not change: detected from the transcripts in ~/.claude. ' +
        'Turn it off if you use Claude from the browser',
    'Percorso di .credentials.json': 'Path of .credentials.json',
    'Sessioni di Claude Code': 'Claude Code sessions',
    ["L'✳ nel pannello ruota mentre Claude lavora, diventa verde quando ha finito " +
        'e arancione quando aspetta te; il dettaglio è nel menu. Tutto letto dai trascritti ' +
        'in ~/.claude/projects: nessun hook, nessuna modifica alla configurazione di Claude Code.']:
        'The ✳ in the panel rotates while Claude is working, turns green when it has finished ' +
        'and orange when it is waiting for you; details are in the menu. Everything is read from the ' +
        'transcripts in ~/.claude/projects: no hooks, no changes to the Claude Code configuration.',
    'Attesa prima di «aspetta te»': 'Delay before «waiting for you»',
    ['Minuti fermo su un tool: può essere un permesso da dare o un comando lungo. ' +
        'Domande e piani da approvare si vedono subito']:
        'Minutes stuck on a tool: it may be a permission to grant or a long command. ' +
        'Questions and plans to approve show up immediately',
    'Notifica anche quando ha finito': 'Also notify when it has finished',
    "Oltre all'✳ verde: utile se il pannello resta nascosto":
        'In addition to the green ✳: useful if the panel stays hidden',
    'Notifica anche quando aspetta te': 'Also notify when it is waiting for you',
    "Oltre all'✳ arancione": 'In addition to the orange ✳',
    'Aspetto': 'Appearance',
    'Mostra la percentuale': 'Show the percentage',
    'Consumo della sessione da 5 ore nel pannello': 'Usage of the 5-hour session in the panel',
    'Mostra il tempo al reset': 'Show the time to reset',
    'Es. «2h46» accanto alla percentuale': 'E.g. «2h46» next to the percentage',
    'Zona della barra': 'Panel area',
    'Sinistra': 'Left',
    'Centro': 'Center',
    'Destra': 'Right',
    'Posizione dentro la zona': 'Position within the area',
    "0 = all'estremità iniziale": '0 = at the start',
    'Soglia di attenzione (%)': 'Warning threshold (%)',
    "Sopra questo valore l'indicatore diventa giallo": 'Above this value the indicator turns yellow',
    'Soglia critica (%)': 'Critical threshold (%)',
    "Sopra questo valore l'indicatore diventa rosso": 'Above this value the indicator turns red',
    'Fuso orario': 'Time zone',
    "L'API restituisce gli orari di reset in UTC: qui si sceglie in che fuso mostrarli.":
        'The API returns reset times in UTC: choose here which time zone to show them in.',
    'Identificatore IANA': 'IANA identifier',
};

const TABLES = {en: EN};

/* Giorni (da lunedì, come GLib) e mesi abbreviati: le date non passano dal
 * locale di sistema, che parlerebbe la lingua del sistema e non quella scelta. */
const DAYS = {
    it: ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'],
    en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};
const MONTHS = {
    it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/* Etichette dei limiti, per `kind` (vedi lib/api.js). */
const LIMIT_LABELS = {
    session: 'Sessione (5h)',
    weekly: 'Settimanale',
    weekly_all: 'Settimanale',
    weekly_opus: 'Settimanale (Opus)',
    weekly_sonnet: 'Settimanale (Sonnet)',
};

let current = 'it';

export function setLanguage(lang) {
    current = LANGUAGES.includes(lang) ? lang : 'it';
}

export function getLanguage() {
    return current;
}

/** Traduce `text` nella lingua corrente e ne riempie i segnaposto {0}, {1}… */
export function _(text, ...args) {
    const out = TABLES[current]?.[text] ?? text;
    return args.length === 0
        ? out
        : out.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m));
}

/** Nome del limite. I dati in cache di versioni precedenti hanno solo `label`. */
export function limitLabel(limit) {
    const key = LIMIT_LABELS[limit?.kind];
    return _(key ?? limit?.label ?? '');
}

/** Giorno della settimana abbreviato: `dow` da 1 (lunedì) a 7, come GLib. */
export function dayName(dow) {
    return DAYS[current][dow - 1];
}

/** Mese abbreviato: `month` da 1 a 12, come GLib. */
export function monthName(month) {
    return MONTHS[current][month - 1];
}

/** Lettera dei giorni nei countdown: «2g3h» / «2d3h». */
export function dayUnit() {
    return current === 'en' ? 'd' : 'g';
}
