/* Lettura di ~/.claude/.credentials.json.
 *
 * SOLA LETTURA: il file non viene mai scritto, così non c'è modo di invalidare
 * il login di Claude Code. Il token viene rinnovato da Claude Code stesso; qui
 * ci limitiamo ad accorgercene tramite un FileMonitor.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_PATH =
    GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

export class CredentialsReader {
    constructor(path) {
        this.path = path || DEFAULT_PATH;
        this._monitor = null;
        this._debounceId = 0;
        this._onChanged = null;
    }

    /**
     * Legge le credenziali. Il callback riceve un oggetto con:
     *   {token, expired, plan}  in caso di successo
     *   {error: 'not-installed' | 'no-file' | 'malformed'}  altrimenti
     * Non viene chiamato se l'operazione è stata annullata.
     */
    read(cancellable, callback) {
        const file = Gio.File.new_for_path(this.path);

        file.load_contents_async(cancellable, (source, res) => {
            let text;
            try {
                const [ok, bytes] = source.load_contents_finish(res);
                if (!ok)
                    throw new Error('load_contents fallita');
                text = new TextDecoder().decode(bytes);
            } catch (e) {
                // Annullata da disable(): non è un errore da segnalare.
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._checkInstalled(file, cancellable, callback);
                else
                    callback({error: 'no-file'});
                return;
            }

            try {
                const oauth = JSON.parse(text)?.claudeAiOauth;
                if (!oauth?.accessToken)
                    throw new Error('claudeAiOauth.accessToken assente');

                callback({
                    token: oauth.accessToken,
                    // expiresAt è in millisecondi
                    expired: Number.isFinite(oauth.expiresAt)
                        ? Date.now() >= oauth.expiresAt
                        : false,
                    plan: oauth.subscriptionType ?? null,
                });
            } catch {
                // Nessun dettaglio nel messaggio: il file contiene un token.
                callback({error: 'malformed'});
            }
        });
    }

    /* Manca il file: senza nemmeno la cartella che lo contiene, Claude Code
     * non è mai partito su questo computer. La cartella e non l'eseguibile nel
     * PATH, perché l'estensione di VS Code porta con sé il proprio `claude` e
     * nel PATH della shell non compare. */
    _checkInstalled(file, cancellable, callback) {
        file.get_parent().query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
            (source, res) => {
                try {
                    source.query_info_finish(res);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    callback({error: e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                        ? 'not-installed' : 'no-file'});
                    return;
                }
                callback({error: 'no-file'});
            });
    }

    /**
     * Sorveglia il file. Il backend inotify di GLib segue la directory padre per
     * quel nome, quindi regge la sostituzione atomica che Claude Code fa quando
     * rinnova il token. Il debounce evita raffiche su write multiple.
     */
    watch(onChanged) {
        this._onChanged = onChanged;

        const file = Gio.File.new_for_path(this.path);
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => {
            if (this._debounceId)
                GLib.Source.remove(this._debounceId);

            this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._debounceId = 0;
                this._onChanged?.();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    destroy() {
        if (this._debounceId) {
            GLib.Source.remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        this._onChanged = null;
    }
}
