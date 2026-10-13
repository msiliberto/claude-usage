/* Rileva se Claude Code sta lavorando.
 *
 * Mentre una sessione è in corso, Claude Code riscrive a ogni messaggio il
 * proprio trascritto in ~/.claude/projects/<progetto>/<sessione>.jsonl: è
 * l'unico file che cambia di continuo, quindi è il segnale di attività più
 * diretto che ci sia. Qui si guarda soltanto *che* sia stato toccato — il file
 * non viene aperto: chi vuole sapere *cosa* è cambiato si registra con
 * `onFileChanged()` (lo fa lib/turns.js, per le notifiche di fine turno).
 *
 * Serve anzitutto a una cosa: se Claude Code non sta lavorando, il consumo non
 * sta cambiando, e non c'è nessun numero nuovo da andare a chiedere all'API.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_PROJECTS_PATH =
    GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);

/* I monitor stanno sulle cartelle di progetto, non sui singoli trascritti: i
 * file di sessione nascono e spariscono di continuo, le cartelle no. Il tetto
 * tiene basso il numero di watch inotify per chi ha molti progetti; si
 * sorvegliano i più recenti, che sono quelli su cui si sta lavorando. */
const MAX_WATCHED_PROJECTS = 32;
const REBUILD_DEBOUNCE = 2000; // ms
const BATCH = 64;

export class ClaudeActivityWatcher {
    constructor(path) {
        this.path = path || DEFAULT_PROJECTS_PATH;
        this._lastActivity = 0; // ms epoch; 0 = non si è ancora visto nulla
        this._root = null;
        this._children = [];
        this._rebuildId = 0;
        this._listeners = [];
        this._cancellable = new Gio.Cancellable();
    }

    /** `callback(file)` a ogni modifica di un file dentro una cartella di progetto. */
    onFileChanged(callback) {
        this._listeners.push(callback);
    }

    /** Millisecondi epoch dell'ultima attività vista; 0 se non se n'è vista. */
    get lastActivity() {
        return this._lastActivity;
    }

    /** C'è stata attività di Claude Code negli ultimi `windowMs` millisecondi. */
    activeWithin(windowMs) {
        return this._lastActivity > 0 && Date.now() - this._lastActivity < windowMs;
    }

    start() {
        const root = Gio.File.new_for_path(this.path);

        try {
            this._root = root.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            // Senza la cartella non c'è niente da sorvegliare. Chi chiama se ne
            // accorge da `lastActivity`, che resta a zero.
            logError(e, 'claude-usage: ~/.claude/projects non sorvegliabile');
            return;
        }

        // Una sessione in una cartella nuova è comunque attività, e obbliga a
        // rifare l'elenco dei figli.
        this._root.connect('changed', () => {
            this._touch();
            this._scheduleRebuild();
        });

        this._rebuildChildren();
    }

    destroy() {
        // Un elenco ancora in corso creerebbe monitor che nessuno chiuderà più.
        this._cancellable.cancel();
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._root?.cancel();
        this._root = null;
        this._unwatchChildren();
        this._listeners = [];
    }

    _touch() {
        this._lastActivity = Date.now();
    }

    _scheduleRebuild() {
        if (this._rebuildId)
            GLib.Source.remove(this._rebuildId);

        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_LOW, REBUILD_DEBOUNCE, () => {
            this._rebuildId = 0;
            this._rebuildChildren();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* L'elenco si legge in asincrono: è poca roba, ma sta sul thread del
     * compositore e lì non si blocca niente per nessun motivo. */
    _rebuildChildren() {
        Gio.File.new_for_path(this.path).enumerate_children_async(
            'standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable,
            (source, res) => {
                try {
                    this._collect(source.enumerate_children_finish(res), []);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'claude-usage: elenco dei progetti non leggibile');
                }
            });
    }

    _collect(enumerator, found) {
        enumerator.next_files_async(BATCH, GLib.PRIORITY_LOW, this._cancellable, (source, res) => {
            let infos;
            try {
                infos = source.next_files_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'claude-usage: elenco dei progetti interrotto');
                source.close_async(GLib.PRIORITY_LOW, null, null);
                return;
            }

            if (infos.length > 0) {
                for (const info of infos) {
                    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                        continue;
                    found.push([
                        info.get_name(),
                        info.get_modification_date_time()?.to_unix() ?? 0,
                    ]);
                }
                this._collect(enumerator, found);
                return;
            }

            source.close_async(GLib.PRIORITY_LOW, null, null);
            this._watchProjects(found);
        });
    }

    _watchProjects(found) {
        this._unwatchChildren();

        found.sort((a, b) => b[1] - a[1]); // i progetti toccati di recente per primi

        for (const [name] of found.slice(0, MAX_WATCHED_PROJECTS)) {
            const dir = Gio.File.new_for_path(GLib.build_filenamev([this.path, name]));
            try {
                const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
                monitor.connect('changed', (_m, file, _other, event) => {
                    this._touch();
                    if (event !== Gio.FileMonitorEvent.DELETED)
                        this._listeners.forEach(callback => callback(file));
                });
                this._children.push(monitor);
            } catch (e) {
                logError(e, `claude-usage: progetto non sorvegliabile (${name})`);
            }
        }
    }

    _unwatchChildren() {
        for (const monitor of this._children)
            monitor.cancel();
        this._children = [];
    }
}
