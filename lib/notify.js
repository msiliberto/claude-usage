/* Notifiche di GNOME Shell per i turni di Claude Code.
 *
 * Vive nell'estensione e non nell'indicatore: la shell ricrea l'indicatore più
 * volte di fila dopo il login, e con lui sparirebbero dal vassoio anche le
 * notifiche già mostrate.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {_} from './i18n.js';

const BODY_MAX = 160; // caratteri del testo finale mostrati nella notifica

export class TurnNotifier {
    constructor(extensionPath) {
        this._icon = Gio.FileIcon.new(Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'icons', 'claude-usage-symbolic.svg'])));
        this._source = null;
    }

    /**
     * @param {string} kind - 'done' | 'asking' | 'waiting'
     * @param {object} turn - la sessione, da lib/turns.js
     * @param {number} delay - secondi di attesa, per 'waiting'
     * @param {object} instance - l'istanza di VS Code della sessione
     */
    show(kind, turn, delay, instance) {
        const project = instance?.name ??
            (turn.cwd ? GLib.path_get_basename(turn.cwd) : 'Claude Code');
        const [title, body, urgency] = this._describe(kind, turn, delay);

        const notification = new MessageTray.Notification({
            source: this._ensureSource(),
            title: `${title} · ${project}`,
            body,
            urgency,
        });
        notification.connect('activated', () => openInstance(instance ?? turn));
        this._source.addNotification(notification);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }

    _describe(kind, turn, delay) {
        const {Urgency} = MessageTray;

        if (kind === 'done')
            return [_('Claude ha finito'), excerpt(turn.text) || _('Turno completato'), Urgency.NORMAL];

        if (kind === 'asking') {
            return turn.tools.includes('ExitPlanMode')
                ? [_('Claude aspetta te'), _('Il piano attende la tua approvazione'), Urgency.HIGH]
                : [_('Claude aspetta te'), _('Ti ha fatto una domanda'), Urgency.HIGH];
        }

        const minutes = Math.round(delay / 60);
        const since = minutes >= 1 ? _('{0} min', minutes) : _('{0} s', delay);
        const tools = [...new Set(turn.tools)].join(', ');
        return [
            _('Claude è fermo da {0}', since),
            _('In attesa su {0}: ti chiede un permesso, oppure il comando è ancora in corso', tools),
            Urgency.HIGH,
        ];
    }

    /* La sorgente si distrugge da sola quando le sue notifiche sono state
     * tutte chiuse: va ricreata alla prossima. */
    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Claude Code', icon: this._icon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }
}

/** Prima riga utile del testo finale, senza la sintassi Markdown più vistosa. */
function excerpt(text) {
    if (!text)
        return '';
    const plain = text.replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
    return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1)}…` : plain;
}

/* I separatori che VS Code mette fra le parti del titolo della finestra
 * («file.js - progetto - Visual Studio Code»). */
const TITLE_SEPARATORS = /\s+[-—–]\s+/;

/* Porta in primo piano la finestra di VS Code aperta sul progetto, riconosciuta
 * dal nome della cartella nel titolo. Vale una parte del titolo uguale al nome
 * — così «app» non prende la finestra di «app-backend» — e solo in mancanza una
 * che lo contenga. Se la finestra non c'è non si fa niente. */
export function openInstance(instance) {
    if (!instance?.cwd)
        return;
    const name = GLib.path_get_basename(instance.cwd);
    const windows = global.display.list_all_windows().filter(w =>
        (w.get_wm_class() ?? '').toLowerCase().includes('code'));
    const window =
        windows.find(w => (w.get_title() ?? '').split(TITLE_SEPARATORS).includes(name)) ??
        windows.find(w => (w.get_title() ?? '').includes(name));
    if (window)
        Main.activateWindow(window);
}
