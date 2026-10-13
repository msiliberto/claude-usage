/* Finestra preferenze (libadwaita). */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_, LANGUAGES, setLanguage} from './lib/i18n.js';

const PANEL_POSITIONS = ['left', 'center', 'right'];
const PANEL_LABELS = ['Sinistra', 'Centro', 'Destra'];
const LANGUAGE_LABELS = ['Italiano', 'English'];

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        let page = this._buildPage(settings);
        window.add(page);

        /* Cambiata la lingua, la pagina si rifà da capo. Non dentro il segnale:
         * si distruggerebbe la tendina che lo sta emettendo. */
        let rebuildId = 0;
        const languageId = settings.connect('changed::language', () => {
            if (rebuildId)
                return;
            rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                rebuildId = 0;
                window.remove(page);
                page = this._buildPage(settings);
                window.add(page);
                return GLib.SOURCE_REMOVE;
            });
        });
        window.connect('close-request', () => {
            settings.disconnect(languageId);
            if (rebuildId)
                GLib.Source.remove(rebuildId);
            rebuildId = 0;
            return false;
        });
    }

    _buildPage(settings) {
        setLanguage(settings.get_string('language'));
        const page = new Adw.PreferencesPage();

        // --- Lingua ---
        const lang = new Adw.PreferencesGroup({title: _('Lingua')});
        const language = new Adw.ComboRow({
            title: _("Lingua dell'interfaccia"),
            model: Gtk.StringList.new(LANGUAGE_LABELS.map(l => _(l))),
            selected: Math.max(0, LANGUAGES.indexOf(settings.get_string('language'))),
        });
        language.connect('notify::selected', row => {
            settings.set_string('language', LANGUAGES[row.selected]);
        });
        lang.add(language);
        page.add(lang);

        // --- Aggiornamento ---
        const updates = new Adw.PreferencesGroup({
            title: _('Aggiornamento'),
            description: _("L'estensione legge soltanto ~/.claude/.credentials.json: non lo modifica mai. " +
                "Fuori dall'intervallo il dato si chiede solo con «Aggiorna ora», nel menu; " +
                'con la sessione inattiva il polling si ferma del tutto.'),
        });

        const interval = new Adw.SpinRow({
            title: _('Intervallo di aggiornamento'),
            subtitle: _("Minuti fra due interrogazioni dell'API (minimo 3): intervalli brevi rischiano il rate limit"),
            adjustment: new Gtk.Adjustment({lower: 3, upper: 60, step_increment: 1}),
        });
        // In GSettings l'intervallo è in secondi, qui si mostra in minuti.
        interval.set_value(Math.max(3, Math.round(settings.get_int('refresh-interval') / 60)));
        interval.connect('notify::value', () =>
            settings.set_int('refresh-interval', Math.round(interval.get_value()) * 60));
        updates.add(interval);

        const onlyWhenActive = new Adw.SwitchRow({
            title: _('Aggiorna solo mentre Claude Code lavora'),
            subtitle: _('A sessione ferma il consumo non cambia: rilevato dai trascritti in ~/.claude. ' +
                'Disattivalo se usi Claude dal browser'),
        });
        settings.bind('poll-only-when-active', onlyWhenActive, 'active', Gio.SettingsBindFlags.DEFAULT);
        updates.add(onlyWhenActive);

        const credentials = new Adw.EntryRow({title: _('Percorso di .credentials.json')});
        credentials.set_show_apply_button(true);
        settings.bind('credentials-path', credentials, 'text', Gio.SettingsBindFlags.DEFAULT);
        updates.add(credentials);
        page.add(updates);

        // --- Sessioni di Claude Code ---
        const alerts = new Adw.PreferencesGroup({
            title: _('Sessioni di Claude Code'),
            description: _("L'✳ nel pannello ruota mentre Claude lavora, diventa verde quando ha finito " +
                'e arancione quando aspetta te; il dettaglio è nel menu. Tutto letto dai trascritti ' +
                'in ~/.claude/projects: nessun hook, nessuna modifica alla configurazione di Claude Code.'),
        });

        const waitingDelay = new Adw.SpinRow({
            title: _('Attesa prima di «aspetta te»'),
            subtitle: _('Minuti fermo su un tool: può essere un permesso da dare o un comando lungo. ' +
                'Domande e piani da approvare si vedono subito'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 30, step_increment: 1}),
        });
        // In GSettings l'attesa è in secondi, qui si mostra in minuti.
        waitingDelay.set_value(Math.max(1, Math.round(settings.get_int('waiting-delay') / 60)));
        waitingDelay.connect('notify::value', () =>
            settings.set_int('waiting-delay', Math.round(waitingDelay.get_value()) * 60));
        alerts.add(waitingDelay);

        const notifyDone = new Adw.SwitchRow({
            title: _('Notifica anche quando ha finito'),
            subtitle: _("Oltre all'✳ verde: utile se il pannello resta nascosto"),
        });
        settings.bind('notify-done', notifyDone, 'active', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(notifyDone);

        const notifyWaiting = new Adw.SwitchRow({
            title: _('Notifica anche quando aspetta te'),
            subtitle: _("Oltre all'✳ arancione"),
        });
        settings.bind('notify-waiting', notifyWaiting, 'active', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(notifyWaiting);
        page.add(alerts);

        // --- Aspetto ---
        const look = new Adw.PreferencesGroup({title: _('Aspetto')});

        const showPercent = new Adw.SwitchRow({
            title: _('Mostra la percentuale'),
            subtitle: _('Consumo della sessione da 5 ore nel pannello'),
        });
        settings.bind('show-percent', showPercent, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(showPercent);

        const showCountdown = new Adw.SwitchRow({
            title: _('Mostra il tempo al reset'),
            subtitle: _('Es. «2h46» accanto alla percentuale'),
        });
        settings.bind('show-countdown', showCountdown, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(showCountdown);

        const position = new Adw.ComboRow({
            title: _('Zona della barra'),
            model: Gtk.StringList.new(PANEL_LABELS.map(l => _(l))),
            selected: Math.max(0, PANEL_POSITIONS.indexOf(settings.get_string('panel-position'))),
        });
        position.connect('notify::selected', row => {
            settings.set_string('panel-position', PANEL_POSITIONS[row.selected]);
        });
        look.add(position);

        const index = new Adw.SpinRow({
            title: _('Posizione dentro la zona'),
            subtitle: _("0 = all'estremità iniziale"),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1}),
        });
        settings.bind('panel-index', index, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(index);

        const warn = new Adw.SpinRow({
            title: _('Soglia di attenzione (%)'),
            subtitle: _("Sopra questo valore l'indicatore diventa giallo"),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 5}),
        });
        settings.bind('warn-threshold', warn, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(warn);

        const critical = new Adw.SpinRow({
            title: _('Soglia critica (%)'),
            subtitle: _("Sopra questo valore l'indicatore diventa rosso"),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 5}),
        });
        settings.bind('critical-threshold', critical, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(critical);
        page.add(look);

        // --- Fuso orario ---
        const time = new Adw.PreferencesGroup({
            title: _('Fuso orario'),
            description: _("L'API restituisce gli orari di reset in UTC: qui si sceglie in che fuso mostrarli."),
        });

        const timezone = new Adw.EntryRow({title: _('Identificatore IANA')});
        timezone.set_show_apply_button(true);
        settings.bind('timezone', timezone, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Segnala subito un identificatore inesistente invece di ricadere in silenzio.
        const validate = () => {
            const text = timezone.get_text();
            const valid = text === '' || GLib.TimeZone.new_identifier(text) !== null;
            if (valid)
                timezone.remove_css_class('error');
            else
                timezone.add_css_class('error');
        };
        timezone.connect('changed', validate);
        validate();

        time.add(timezone);
        page.add(time);

        return page;
    }
}
