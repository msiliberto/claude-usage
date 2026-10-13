/* Claude Usage — indicatore del consumo dei limiti di Claude nella barra superiore. */

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { ClaudeActivityWatcher } from "./lib/activity.js";
import { UsageClient } from "./lib/api.js";
import { CredentialsReader } from "./lib/credentials.js";
import * as Fmt from "./lib/format.js";
import { _, limitLabel, setLanguage } from "./lib/i18n.js";
import { TurnNotifier, openInstance } from "./lib/notify.js";
import { ClaudeTurnWatcher, scanClaudeProcesses } from "./lib/turns.js";

const TICK_SECONDS = 30; // solo ricalcolo del countdown, nessuna rete
const BAR_WIDTH = 220;

/* --- contenimento del traffico verso l'API ---
 *
 * Il 429 arrivava molto prima di quanto lasciasse pensare il solo intervallo
 * di aggiornamento, perché le richieste partivano da più parti e solo una
 * guardava il backoff: il poll, ogni apertura del menu (e con l'hover il menu
 * si apre a ogni passaggio del mouse) e ogni riscrittura del file delle
 * credenziali da parte di Claude Code. L'apertura del menu ora non chiede più
 * niente — passare il mouse sull'indicatore è un gesto troppo frequente per
 * costare una richiesta, e per il dato fresco c'è «Aggiorna ora» — e quel che
 * resta passa tutto da `_requestSoon()`, che al più anticipa il tentativo già
 * in programma: due richieste non possono mai essere più vicine di
 * MIN_REQUEST_SPACING, e durante un backoff non parte proprio nulla. */
const MIN_REQUEST_SPACING = 60; // s fra due richieste, qualunque ne sia il motivo
const RATE_LIMIT_BACKOFF = 300; // s dopo il primo 429, poi raddoppia
const MAX_RETRY_WAIT = 3600; // s: tetto a ciò che il server può farci aspettare
const BOOT_DELAY = 240; // s di attesa prima della prima richiesta
const DAY_MS = 24 * 3600 * 1000;
const MAX_BACKOFF_SECONDS = 900;
const BACKOFF_JITTER = 0.2; // ±20%, per non ripresentarsi sempre in fase
const IDLE_PAUSE_SECONDS = 300; // s di inattività dopo cui il polling si ferma
const ACTIVITY_WINDOW = 600; // s dall'ultimo segno di vita di Claude Code

/* Apertura del menu al passaggio del mouse. */
const HOVER_OPEN_DELAY = 100; // ms fermi sull'indicatore prima di aprire
const HOVER_CLOSE_DELAY = 100; // ms fuori da indicatore e menu prima di chiudere
const HOVER_POLL_INTERVAL = 120; // ms fra due letture della posizione del puntatore
const HOVER_MARGIN = 6; // px di tolleranza sullo stacco fra pannello e menu

/* Mantenimento della posizione nella zona del pannello. */
const PLACEMENT_SETTLE_DELAY = 50; // ms: raccoglie una raffica di inserimenti
const PLACEMENT_MAX_MOVES = 40; // spostamenti oltre i quali si lascia perdere
const PLACEMENT_MOVES_WINDOW = 10000; // ms in cui vengono contati

/* Le copie dell'indicatore sugli altri schermi stanno a pochi livelli da
 * `uiGroup`: il pannello aggiunto come chrome, poi le sue tre zone, poi il
 * pulsante. Sei livelli bastano e tengono la scansione a poche decine di
 * attori invece che a tutto l'albero della shell. */
/* Chiavi che l'estensione scrive da sé per non ripartire da zero: non sono
 * preferenze, e rispondere a un loro cambiamento sarebbe solo lavoro sprecato. */
const STATE_KEYS = [
  "last-request",
  "retry-until",
  "backoff-failures",
  "cached-usage",
  "cached-at",
];

const MIRROR_SCAN_DEPTH = 6;
const MIRROR_SCAN_DELAY = 1500; // ms: il tempo che l'altra estensione si ricostruisca

/* Diagnostica: attivare con CLAUDE_USAGE_DEBUG=1 nell'ambiente della sessione,
 * poi seguire con `journalctl --user -f -o cat | grep claude-usage`. */
const DEBUG = GLib.getenv("CLAUDE_USAGE_DEBUG") !== null;
const debug = (msg) => {
  if (DEBUG) console.log(`claude-usage: ${msg}`);
};

/* Stato dei turni di Claude Code sull'✳ del pannello. L'icona ha simmetria
 * di 45°: ruotarla a scatti fino a 45° e ricominciare da 0 non si vede, e
 * bastano pochi ridisegni al secondo invece di un'animazione a 60 fps che
 * terrebbe sveglia la GPU per tutto il tempo in cui Claude lavora. */
const TURN_CLASSES = {
  working: "claude-turn-working",
  done: "claude-turn-done",
  waiting: "claude-turn-waiting",
};
const SPIN_STEP = 15; // gradi per scatto
const SPIN_INTERVAL = 160; // ms fra due scatti
const PULSE_INTERVAL = 1400; // ms fra due inversioni della pulsazione
const PULSE_FADE = 700; // ms di dissolvenza
const PULSE_LOW = 90; // opacità minima, su 255
const CLOSED_CHECK_DELAY = 2500; // ms dopo la chiusura di VS Code: i processi devono uscire

const SEVERITY_CLASSES = [
  "claude-usage-normal",
  "claude-usage-warn",
  "claude-usage-critical",
];
const FILL_CLASSES = ["", "claude-bar-fill-warn", "claude-bar-fill-critical"];

/** Blocco "titolo + percentuale + barra + riga di reset" usato nel menu. */
class LimitBlock {
  constructor() {
    this.actor = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "claude-menu-section",
      x_expand: true,
    });

    const header = new St.BoxLayout({ x_expand: true });
    this._title = new St.Label({
      style_class: "claude-menu-title",
      x_expand: true,
    });
    this._percent = new St.Label({ style_class: "claude-menu-title" });
    header.add_child(this._title);
    header.add_child(this._percent);

    this._track = new St.BoxLayout({
      style_class: "claude-bar-track",
      x_expand: false,
    });
    this._fill = new St.Widget({
      style_class: "claude-bar-fill",
      x_expand: false,
    });
    this._track.add_child(this._fill);

    this._detail = new St.Label({ style_class: "claude-menu-detail" });

    this.actor.add_child(header);
    this.actor.add_child(this._track);
    this.actor.add_child(this._detail);
  }

  update(limit, tz, severityLevel) {
    this._title.text = limitLabel(limit);
    this._percent.text = Fmt.formatPercent(limit.percent);

    const width = Math.round(
      (Math.min(100, Math.max(0, limit.percent)) * BAR_WIDTH) / 100,
    );
    this._fill.style = `width: ${width}px;`;

    for (const cls of FILL_CLASSES.filter((c) => c))
      this._fill.remove_style_class_name(cls);
    if (FILL_CLASSES[severityLevel])
      this._fill.add_style_class_name(FILL_CLASSES[severityLevel]);

    const at = Fmt.formatResetTime(limit.resetsAt, tz);
    const inTime = Fmt.formatCountdown(limit.resetsAt);
    this._detail.text =
      limit.resetsAt === null
        ? _("nessun reset programmato")
        : _("reset {0} · tra {1}", at, inTime);
  }

  destroy() {
    this._title.destroy();
    this._percent.destroy();
    this._detail.destroy();
    this._fill.destroy();
    this._track.destroy();
    this.actor.destroy();
    this.actor = null;
    this._title = null;
    this._percent = null;
    this._track = null;
    this._fill = null;
    this._detail = null;
  }
}

const ClaudeIndicator = GObject.registerClass(
  class ClaudeIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.5, "Claude Usage", false);

      this._extension = extension;
      this._settings = extension.getSettings();

      this._data = null;
      this._plan = null;
      this._state = "loading"; // loading | cached | ok | stale | rate-limit | not-installed | no-credentials | error
      this._lastUpdate = null; // Date.now(): serve solo per l'orario mostrato
      this._failures = 0;
      this._pending = false;

      /* Tempi del gate, in millisecondi monotoni: un aggiustamento dell'orologio
       * di sistema non deve poter sbloccare un backoff in corso. */
      this._lastAttemptAt = 0;
      this._nextAllowedAt = 0;
      this._idle = false;

      this._cancellable = new Gio.Cancellable();
      this._client = new UsageClient();
      this._activity = new ClaudeActivityWatcher();
      this._turns = new ClaudeTurnWatcher({
        onChange: () => this._renderTurns(),
        onEvent: (kind, session) => this._notifyTurn(kind, session),
        waitingDelay: () => this._settings.get_int("waiting-delay"),
      });
      this._turnStatus = "idle:false";
      this._closedCheckId = 0;
      this._scanningProcesses = false;
      /* Chiusa una finestra di VS Code, le sue chat muoiono con lei: si
       * ricontrolla dopo poco, senza aspettare il tick. */
      this._windowDestroyId = global.window_manager.connect(
        "destroy",
        (_wm, actor) => {
          const wmClass = actor.meta_window?.get_wm_class() ?? "";
          if (wmClass.toLowerCase().includes("code")) this._scheduleClosedCheck();
        },
      );
      this._sessionsLayout = null;
      this._sessionRows = new Map();
      this._spinId = 0;
      this._pulseId = 0;
      this._activity.onFileChanged((file) => this._turns.fileChanged(file));
      this._activity.start();
      this._reader = new CredentialsReader(this._credentialsPath());
      this._reader.watch(() => this._requestSoon("credentials"));

      this._pollId = 0;
      this._tickId = 0;
      this._idleMonitor = null;
      this._idleWatchId = 0;
      this._activeWatchId = 0;

      this._mirrors = [];
      this._mirrorScanId = 0;
      this._monitorsChangedId = 0;
      this._extensionStateId = 0;

      this._hoverOpenId = 0;
      this._hoverPollId = 0;
      this._outsideSince = 0;
      this._openedByHover = false;
      this._suppressUntilLeave = false;

      this._restoreState();

      this._buildPanelButton(extension.path);
      this._buildMenu();
      this._render(); // il dato in cache si vede subito, senza passare da "…"

      this._settingsChangedId = this._settings.connect("changed", (_s, key) => {
        if (STATE_KEYS.includes(key)) return; // scritte da noi, non da chi configura
        if (key === "language") return; // ci pensa l'estensione, ricreandoci

        if (key === "credentials-path") {
          this._reader.destroy();
          this._reader = new CredentialsReader(this._credentialsPath());
          this._reader.watch(() => this._requestSoon("credentials"));
          this._requestSoon("credentials");
        } else if (key === "refresh-interval") {
          this._scheduleAt(this._now() + this._nextDelay() * 1000);
        } else {
          this._render();
        }
      });

      this.connect("notify::hover", () => this._onHoverChanged(this));

      this._menuOpenStateId = this.menu.connect("open-state-changed", (_menu, isOpen) => {
        if (isOpen) {
          if (this._openedByHover) this._startHoverWatch();
          this._turns.markSeen(); // guardare il menu vale come «letto»
        } else {
          this._stopHoverWatch();
          this._openedByHover = false;
          // Chiuso con il puntatore ancora sull'indicatore — Esc, o una chiusura
          // decisa dalla shell — il rilascio del grab rimanda un enter sul
          // pulsante: senza questo il menu si riaprirebbe all'istante.
          this._suppressUntilLeave = this._pointerOnIndicator();
        }
      });

      this._requestSoon("boot");
      this._checkCredentials();
      this._watchIdle();

      /* Le copie sugli altri schermi compaiono e spariscono al variare del
       * numero di monitor e quando l'estensione che le crea viene attivata,
       * disattivata o ricaricata. */
      this._scheduleMirrorScan();
      this._monitorsChangedId = Main.layoutManager.connect(
        "monitors-changed",
        () => this._scheduleMirrorScan(),
      );
      this._extensionStateId = Main.extensionManager.connect(
        "extension-state-changed",
        () => this._scheduleMirrorScan(),
      );

      this._tickId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        TICK_SECONDS,
        () => {
          this._render();
          this._turns.prune();
          this._checkClosedSessions();
          this._renderTurns(); // «fermo da 4 min» invecchia anche senza eventi
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    /* --- stato dei turni di Claude Code --- */

    _renderTurns() {
      if (!this._turns) return;
      this._setTurnStatus(this._turns.summary);
      this._renderSessions();
      // Il nome di un'istanza nuova viene da /proc: non si aspetta il tick.
      if (this._turns.hasUnnamedInstances) this._checkClosedSessions();
    }

    _scheduleClosedCheck() {
      if (this._closedCheckId) GLib.Source.remove(this._closedCheckId);
      this._closedCheckId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        CLOSED_CHECK_DELAY,
        () => {
          this._closedCheckId = 0;
          this._checkClosedSessions();
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    /* Senza sessioni in elenco non c'è niente da togliere, e /proc non si
     * guarda nemmeno: è il caso di gran lunga più frequente. La scansione gira
     * in un processo a parte; ne parte una alla volta. */
    _checkClosedSessions() {
      if (!this._turns?.hasSessions || this._scanningProcesses) return;

      this._scanningProcesses = true;
      scanClaudeProcesses(this._cancellable)
        .then((live) => this._turns?.dropClosed(live))
        .catch((e) => {
          if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            debug(`processi di Claude Code non letti: ${e.message}`);
        })
        .finally(() => {
          this._scanningProcesses = false;
        });
    }

    /* Il colore dice lo stato più urgente, la rotazione che qualcosa lavora
     * ancora: una chat finita accende il verde senza fermare l'✳ se un'altra,
     * in questa finestra o in un'altra, sta lavorando. «Aspetta te» vince su
     * tutto: pulsa e basta. */
    _setTurnStatus({ status, busy }) {
      const key = `${status}:${busy}`;
      if (key === this._turnStatus) return;
      this._turnStatus = key;
      debug(`stato dei turni: ${status}${busy ? " (qualcosa lavora)" : ""}`);

      for (const cls of Object.values(TURN_CLASSES))
        this._icon.remove_style_class_name(cls);
      if (TURN_CLASSES[status])
        this._icon.add_style_class_name(TURN_CLASSES[status]);

      this._stopIconAnimation();
      if (status === "waiting") this._startPulse();
      else if (status === "working" || (status === "done" && busy))
        this._startSpin();
    }

    _startSpin() {
      this._spinId = GLib.timeout_add(GLib.PRIORITY_LOW, SPIN_INTERVAL, () => {
        this._icon.rotation_angle_z =
          (this._icon.rotation_angle_z + SPIN_STEP) % 45;
        return GLib.SOURCE_CONTINUE;
      });
    }

    /* L'unico stato in cui devi fare qualcosa è anche l'unico che si muove
     * per farsi notare: dissolvenze lente, e fra l'una e l'altra niente
     * ridisegni. */
    _startPulse() {
      let low = false;
      this._pulseId = GLib.timeout_add(
        GLib.PRIORITY_LOW,
        PULSE_INTERVAL,
        () => {
          low = !low;
          this._icon.ease({
            opacity: low ? PULSE_LOW : 255,
            duration: PULSE_FADE,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
          });
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _stopIconAnimation() {
      if (this._spinId) {
        GLib.Source.remove(this._spinId);
        this._spinId = 0;
      }
      if (this._pulseId) {
        GLib.Source.remove(this._pulseId);
        this._pulseId = 0;
      }
      this._icon.remove_all_transitions();
      this._icon.rotation_angle_z = 0;
      this._icon.opacity = 255;
    }

    /* I colori di stato hanno una variante per i pannelli chiari: lo si
     * capisce dal colore del testo che il tema dà al pulsante, non dalla
     * preferenza chiaro/scuro, perché c'è chi ha il pannello scuro col tema
     * chiaro e viceversa. */
    _updatePanelTone() {
      const node = this.get_theme_node?.();
      if (!node) return;
      const fg = node.get_foreground_color();
      const light =
        (0.299 * fg.red + 0.587 * fg.green + 0.114 * fg.blue) / 255 < 0.5;
      if (light === this._lightPanel) return; // evita di rinnescare style-changed
      this._lightPanel = light;
      if (light) this.add_style_class_name("claude-usage-light-panel");
      else this.remove_style_class_name("claude-usage-light-panel");
    }

    /* Le righe si aggiornano sul posto e si ricreano solo quando cambia
     * l'elenco. Mentre Claude lavora il trascritto si muove ogni pochi
     * secondi: ricostruire il menu a ogni modifica distruggeva la riga fra la
     * pressione e il rilascio del clic, e il clic andava perso. */
    _renderSessions() {
      const instances = this._turns.instances;
      const layout = instances.map((i) => i.key).join("\n");

      if (layout !== this._sessionsLayout) {
        this._sessionsLayout = layout;
        this._sessionRows = new Map();
        this._sessionsSection.removeAll();
        this._sessionsSeparator.visible = instances.length > 0;

        if (instances.length > 0) {
          const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
          });
          header.add_child(
            new St.Label({
              text: _("Sessioni"),
              style_class: "claude-menu-header",
            }),
          );
          this._sessionsSection.addMenuItem(header);
        }
        for (const instance of instances) this._addSessionRow(instance.key);
      }

      const tz = this._timeZone();
      for (const instance of instances) {
        const row = this._sessionRows.get(instance.key);
        row.dot.style_class = `claude-session-dot ${TURN_CLASSES[instance.status] ?? ""}`;
        row.dot.text = instance.status === "idle" ? "○" : "●"; // idle: finito e già visto
        row.title.text = instance.name;
        row.detail.text = this._instanceDetail(instance, tz);
      }
    }

    /* Più chat nella stessa finestra sono una riga sola: si racconta la più
     * urgente e si contano le altre che lavorano ancora. */
    _instanceDetail(instance, tz) {
      const [first, ...others] = instance.sessions;
      const detail = this._sessionDetail(first, tz);
      const working = others.filter((s) => s.status === "working").length;
      if (first.status === "working" || working === 0) return detail;
      return working === 1
        ? _("{0} · un'altra al lavoro", detail)
        : _("{0} · altre {1} al lavoro", detail, working);
    }

    _addSessionRow(key) {
      const item = new PopupMenu.PopupBaseMenuItem();
      const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });
      const line = new St.BoxLayout();
      const dot = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
      const title = new St.Label({ style_class: "claude-menu-title" });
      const detail = new St.Label({
        style_class: "claude-menu-detail claude-session-detail",
      });
      line.add_child(dot);
      line.add_child(title);
      box.add_child(line);
      box.add_child(detail);
      item.add_child(box);

      // L'istanza si rilegge al clic: lo stato catturato qui invecchia.
      item.connect("activate", () =>
        openInstance(this._turns?.instances.find((i) => i.key === key)),
      );
      this._sessionsSection.addMenuItem(item);
      this._sessionRows.set(key, { dot, title, detail });
    }

    _sessionDetail(session, tz) {
      const minutes = Math.max(
        0,
        Math.floor((Date.now() - session.since) / 60000),
      );
      const ago = minutes < 1 ? _("meno di un minuto") : _("{0} min", minutes);
      const tools = [...new Set(session.tools)].join(", ");

      switch (session.status) {
        case "asking":
          return session.tools.includes("ExitPlanMode")
            ? _("Aspetta te: piano da approvare · da {0}", ago)
            : _("Aspetta te: ti ha fatto una domanda · da {0}", ago);
        case "waiting":
          return _(
            "Fermo da {0} su {1}\npermesso da dare, o comando ancora in corso",
            ago,
            tools,
          );
        case "done":
          return _("Finito alle {0}", Fmt.formatClock(session.since, tz));
        default:
          return tools ? _("Sta lavorando · {0}", tools) : _("Sta lavorando");
      }
    }

    _notifyTurn(kind, turn) {
      const key = kind === "done" ? "notify-done" : "notify-waiting";
      if (!this._settings.get_boolean(key)) return;
      debug(`turno: ${kind} (${turn.cwd})`);
      this._extension.notifier?.show(
        kind,
        turn,
        this._settings.get_int("waiting-delay"),
        this._turns?.instanceFor(turn),
      );
    }

    _credentialsPath() {
      return this._settings.get_string("credentials-path") || null;
    }

    _timeZone() {
      return Fmt.resolveTimeZone(this._settings.get_string("timezone"));
    }

    _buildPanelButton(extensionPath) {
      this.add_style_class_name("claude-usage-button");

      const box = new St.BoxLayout({ style_class: "panel-status-menu-box" });

      this._icon = new St.Icon({
        gicon: Gio.icon_new_for_string(
          `${extensionPath}/icons/claude-usage-symbolic.svg`,
        ),
        style_class: "system-status-icon claude-usage-icon",
      });
      this._label = new St.Label({
        text: "…",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "claude-usage-label",
      });

      box.add_child(this._icon);
      box.add_child(this._label);
      this.add_child(box);

      this._icon.set_pivot_point(0.5, 0.5);
      this._lightPanel = null;
      this.connect("style-changed", () => this._updatePanelTone());
    }

    _buildMenu() {
      this._sessionBlock = new LimitBlock();
      const sessionItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      sessionItem.add_child(this._sessionBlock.actor);
      this.menu.addMenuItem(sessionItem);

      // I limiti settimanali possono variare di numero: ricostruiti a ogni update.
      this._weeklyBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });
      this._weeklyBlocks = [];
      const weeklyItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      weeklyItem.add_child(this._weeklyBox);
      this.menu.addMenuItem(weeklyItem);

      // Le sessioni di Claude Code: compaiono solo se ce n'è qualcuna da dire.
      this._sessionsSeparator = new PopupMenu.PopupSeparatorMenuItem();
      this._sessionsSeparator.visible = false;
      this.menu.addMenuItem(this._sessionsSeparator);
      this._sessionsSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._sessionsSection);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this._footer = new St.Label({ style_class: "claude-menu-footer" });
      const footerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      footerItem.add_child(this._footer);
      this.menu.addMenuItem(footerItem);

      const refreshItem = new PopupMenu.PopupMenuItem(_("Aggiorna ora"));
      refreshItem.connect("activate", () =>
        this._requestSoon(this._state === "rate-limit" ? "force" : "manual"),
      );
      this._refreshItem = refreshItem;
      this.menu.addMenuItem(refreshItem);

      const prefsItem = new PopupMenu.PopupMenuItem(_("Impostazioni"));
      prefsItem.connect("activate", () => this._extension.openPreferences());
      this.menu.addMenuItem(prefsItem);
    }

    /* Il click non fa niente. Il menu si apre e si chiude da sé al passaggio del
     * mouse, e il toggle che PanelMenu.Button fa qui non poteva che litigarci:
     * cliccare su un menu già aperto per hover lo chiudeva, e il suppress lo
     * teneva chiuso finché il puntatore non se ne andava — da fuori sembrava
     * che il click avesse disattivato l'hover. Per il dato fresco c'è
     * «Aggiorna ora»; da tastiera resta vfunc_key_press_event. */
    vfunc_event(_event) {
      return Clutter.EVENT_PROPAGATE;
    }

    /* --- apertura al passaggio del mouse ---
     *
     * Mentre il menu è aperto la shell tiene un grab modale sul suo attore: il
     * pulsante riceve un leave "finto" e la proprietà `hover` non dice più dove
     * sia davvero il puntatore. Per questo l'apertura si decide sull'hover, ma
     * la chiusura leggendo la posizione del puntatore a intervalli.
     */

    _onHoverChanged(actor) {
      if (this.menu.isOpen) return;

      this._cancelHoverOpen();

      if (this._suppressUntilLeave) {
        // Uscito davvero da tutte le copie: si può riaprire.
        if (!this._pointerOnIndicator()) this._suppressUntilLeave = false;
        return;
      }

      if (!actor.hover) return;

      this._hoverOpenId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        HOVER_OPEN_DELAY,
        () => {
          this._hoverOpenId = 0;
          if (actor.hover && !this.menu.isOpen) {
            this._openedByHover = true;
            this._openMenuAt(actor);
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    /** Apre il menu ancorandolo all'attore da cui è arrivato il puntatore. */
    _openMenuAt(actor) {
      if (actor === this) {
        this.menu.open(BoxPointer.PopupAnimation.FULL);
        return;
      }

      /* Il menu è uno solo e vive sullo schermo primario: per farlo comparire
       * accanto alla copia bisogna spostarne l'ancoraggio, e chi sa come farlo
       * è l'estensione che la copia l'ha creata. È la stessa strada che il
       * click percorre già, quindi qui si riusa quella. */
      try {
        if (typeof actor._onButtonPress === "function") {
          actor._onButtonPress();
          return;
        }
      } catch (e) {
        debug(`apertura dalla copia non riuscita: ${e}`);
      }

      this.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _cancelHoverOpen() {
      if (this._hoverOpenId) {
        GLib.Source.remove(this._hoverOpenId);
        this._hoverOpenId = 0;
      }
    }

    _startHoverWatch() {
      this._stopHoverWatch();
      this._outsideSince = 0;

      this._hoverPollId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        HOVER_POLL_INTERVAL,
        () => {
          const now = GLib.get_monotonic_time() / 1000;

          if (this._pointerOnIndicator() || this._pointerOn(this.menu.actor)) {
            this._outsideSince = 0;
            return GLib.SOURCE_CONTINUE;
          }
          if (!this._outsideSince) this._outsideSince = now;
          if (now - this._outsideSince < HOVER_CLOSE_DELAY)
            return GLib.SOURCE_CONTINUE;

          // Azzerato prima di chiudere: `close()` rientra da open-state-changed.
          this._hoverPollId = 0;
          this.menu.close(BoxPointer.PopupAnimation.FULL);
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _stopHoverWatch() {
      if (this._hoverPollId) {
        GLib.Source.remove(this._hoverPollId);
        this._hoverPollId = 0;
      }
      this._outsideSince = 0;
    }

    /** Il puntatore è sull'indicatore o su una delle sue copie sugli altri schermi. */
    _pointerOnIndicator() {
      return (
        this._pointerOn(this) ||
        this._mirrors.some((m) => this._pointerOn(m.actor))
      );
    }

    /** Il puntatore è sopra `actor`, con un margine per lo stacco fra i due riquadri. */
    _pointerOn(actor) {
      if (!actor.visible) return false;

      const [x, y] = global.get_pointer();
      const [ax, ay] = actor.get_transformed_position();
      const [w, h] = actor.get_transformed_size();

      return (
        x >= ax - HOVER_MARGIN &&
        x <= ax + w + HOVER_MARGIN &&
        y >= ay - HOVER_MARGIN &&
        y <= ay + h + HOVER_MARGIN
      );
    }

    /** 0 = normale, 1 = attenzione, 2 = critico. */
    _severityLevel(percent, apiSeverity) {
      const warn = this._settings.get_int("warn-threshold");
      const critical = this._settings.get_int("critical-threshold");

      let level = 0;
      if (percent >= critical) level = 2;
      else if (percent >= warn) level = 1;

      // L'API può segnalare una criticità che le soglie locali non colgono.
      if (apiSeverity && apiSeverity !== "normal")
        level = Math.max(level, apiSeverity === "critical" ? 2 : 1);

      return level;
    }

    /* --- gate delle richieste ---
     *
     * C'è un solo tentativo in programma alla volta, e `_fetch()` parte solo
     * da lì. Chi vuole un dato più fresco lo anticipa passando da
     * `_requestSoon()`; nessuno può aggiungere una richiesta in più.
     */

    /** Millisecondi monotoni: immuni agli aggiustamenti dell'orologio di sistema. */
    _now() {
      return GLib.get_monotonic_time() / 1000;
    }

    /* --- lo stato del gate sopravvive all'indicatore ---
     *
     * L'indicatore non è eterno: la shell lo distrugge e lo ricostruisce a ogni
     * cambio di modalità di sessione, e dopo il login capita più volte di fila
     * (tre, in due minuti, sulla macchina su cui è nato questo commento).
     * Finché il gate viveva solo in memoria, ognuna di quelle istanze ripartiva
     * da zero e la prima cosa che faceva era chiedere subito un dato nuovo: era
     * quella la raffica che portava al 429, non il polling. Ora i tempi stanno
     * in GSettings, dove sopravvivono alla ricreazione e al riavvio della shell.
     */

    /**
     * Da millisecondi epoch a millisecondi monotoni, conservando il segno: un
     * istante futuro resta futuro. Lo scarto è limitato perché un orologio
     * spostato all'indietro, o un valore rimasto lì da giorni, non deve poter
     * bloccare gli aggiornamenti per sempre.
     */
    _monoFromWall(wall) {
      if (!wall) return 0;

      const offset = wall - Date.now();
      const bounded = Math.min(
        Math.max(offset, -DAY_MS),
        MAX_RETRY_WAIT * 1000,
      );
      return this._now() + bounded;
    }

    _restoreState() {
      this._lastAttemptAt = this._monoFromWall(
        Number(this._settings.get_int64("last-request")),
      );

      const retryUntil = Number(this._settings.get_int64("retry-until"));
      this._nextAllowedAt = this._monoFromWall(retryUntil);

      // I fallimenti accumulati contano solo finché dura l'attesa che hanno
      // prodotto: più tardi sarebbero una penalità senza più una ragione.
      this._failures =
        retryUntil > Date.now()
          ? this._settings.get_int("backoff-failures")
          : 0;

      debug(
        `stato ripristinato: ultima richiesta ${Math.round((this._now() - this._lastAttemptAt) / 1000)}s fa, ` +
          `prossima fra ${Math.round((this._nextAllowedAt - this._now()) / 1000)}s, ` +
          `${this._failures} fallimenti`,
      );

      const cachedAt = Number(this._settings.get_int64("cached-at"));
      const cached = this._settings.get_string("cached-usage");
      if (!cached || !cachedAt) return;

      try {
        this._data = JSON.parse(cached);
        this._lastUpdate = cachedAt;
        this._state = "cached";
      } catch (e) {
        debug(`dato in cache illeggibile: ${e}`);
      }
    }

    _persistAttempt() {
      this._settings.set_int64("last-request", Date.now());
    }

    _persistSchedule() {
      const wait = Math.max(0, this._nextAllowedAt - this._now());
      this._settings.set_int64("retry-until", Date.now() + wait);
      this._settings.set_int("backoff-failures", Math.min(this._failures, 100));
    }

    _persistData() {
      this._settings.set_string("cached-usage", JSON.stringify(this._data));
      this._settings.set_int64("cached-at", this._lastUpdate);
    }

    /**
     * Chiede un aggiornamento. `reason` dice quanto la richiesta ha diritto di
     * passare avanti:
     *   'credentials' Claude Code ha riscritto il token
     *   'manual'      «Aggiorna ora»
     *   'wake'        l'utente è tornato dopo una pausa
     *   'boot'        indicatore appena costruito
     */
    _requestSoon(reason) {
      const now = this._now();

      /* «Refresh forzato»: l'utente accetta di insistere durante un 429, quindi
       * né il distanziamento né il backoff contano. */
      if (reason === "force") {
        debug("refresh forzato");
        this._scheduleAt(now, reason);
        return;
      }

      let at = Math.max(now, this._lastAttemptAt + MIN_REQUEST_SPACING * 1000);

      /* Un'attesa da 429 non si scavalca mai: insistere la allunga soltanto, ed
       * è esattamente così che ci si finisce dentro. Dopo gli altri errori si
       * riparte subito, perché 'credentials' e 'manual' arrivano da un fatto
       * nuovo (token rinnovato, utente che chiede) che vale la pena provare;
       * 'wake' invece non è un fatto nuovo, è solo tempo passato. */
      if (
        reason === "wake" ||
        reason === "boot" ||
        this._state === "rate-limit"
      )
        at = Math.max(at, this._nextAllowedAt);

      /* All'accensione la rete e il login di Claude Code non sono ancora a
       * posto, e una richiesta subito è quota spesa per niente. */
      if (reason === "boot") at = Math.max(at, now + BOOT_DELAY * 1000);

      // Il tentativo già in programma arriva prima: non c'è niente da anticipare.
      if (this._pollId && at >= this._nextAllowedAt) return;

      debug(`aggiornamento anticipato (${reason})`);
      this._scheduleAt(at, reason);
    }

    /**
     * Sposta l'unico tentativo in programma all'istante monotono `when`.
     * `reason` viaggia fino al timer perché solo il poll periodico è
     * subordinato al fatto che Claude Code stia lavorando.
     */
    _scheduleAt(when, reason = "poll") {
      if (this._pollId) {
        GLib.Source.remove(this._pollId);
        this._pollId = 0;
      }

      this._nextAllowedAt = when;
      this._persistSchedule();
      if (this._idle) return; // si riprende quando l'utente torna

      const delay = Math.max(0, Math.round(when - this._now()));
      this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        this._pollId = 0;
        this._fetch(reason);
        return GLib.SOURCE_REMOVE;
      });
    }

    /** Secondi da aspettare dopo l'esito appena registrato. */
    _nextDelay(retryAfter = 0) {
      const base = this._settings.get_int("refresh-interval");
      if (this._failures === 0) return base;

      // Se il server dice quanto aspettare ha ragione lui, anche oltre il tetto.
      if (retryAfter > 0) return Math.min(retryAfter + 5, MAX_RETRY_WAIT);

      const delay =
        this._state === "rate-limit"
          ? RATE_LIMIT_BACKOFF * 2 ** Math.min(this._failures - 1, 3)
          : base * 2 ** Math.min(this._failures, 4);

      const capped = Math.min(delay, MAX_BACKOFF_SECONDS);
      return Math.round(
        capped * (1 + BACKOFF_JITTER * (Math.random() * 2 - 1)),
      );
    }

    _fetch(reason = "poll") {
      if (this._pending) return;

      /* Il consumo si muove solo mentre Claude Code lavora: a sessione ferma
       * l'API risponderebbe ogni volta lo stesso numero, e ogni richiesta
       * sarebbe soltanto quota bruciata. Vale per i tentativi di routine —
       * l'avvio e «Aggiorna ora» passano comunque. */
      if ((reason === "poll" || reason === "wake") && this._claudeIsIdle()) {
        const wait = this._settings.get_int("refresh-interval");
        debug(`Claude Code fermo: poll saltato, riprovo fra ${wait}s`);
        this._scheduleAt(this._now() + wait * 1000, "poll");
        return;
      }

      this._pending = true;
      // Segnato prima della lettura del file: anche un errore di credenziali
      // deve contare come tentativo, o una raffica di modifiche al file
      // diventerebbe una raffica di letture.
      this._lastAttemptAt = this._now();
      this._persistAttempt();

      this._reader.read(this._cancellable, (creds) => {
        if (creds.error) {
          this._pending = false;
          this._state =
            creds.error === "not-installed" ? "not-installed" : "no-credentials";
          this._render();
          this._scheduleAt(this._now() + this._nextDelay() * 1000);
          return;
        }

        this._plan = creds.plan;

        /* Token già scaduto secondo il file (tipico al mattino dopo): la
         * richiesta fallirebbe di sicuro, e al boot, con la rete non ancora
         * pronta, comparirebbe «Aggiornamento non riuscito» al posto della
         * causa vera. Niente richiesta, niente backoff: quando Claude Code
         * riscrive il file il FileMonitor ci sveglia; il ricontrollo è solo
         * una rete di sicurezza e costa una lettura di file. */
        if (creds.expired) {
          this._pending = false;
          this._state = "stale";
          this._failures = 0;
          this._scheduleAt(
            this._now() + this._settings.get_int("refresh-interval") * 1000,
          );
          this._render();
          debug("token scaduto nel file: richiesta saltata");
          return;
        }

        this._client.fetch(
          creds.token,
          this._cancellable,
          (err, data, retryAfter) => {
            this._pending = false;

            if (err === "auth") {
              // Token scaduto: Claude Code lo rinnoverà al prossimo avvio e il
              // FileMonitor ci sveglierà. Nel frattempo il dato resta quello vecchio.
              this._state = "stale";
              this._failures++;
            } else if (err === "rate-limit") {
              // Il backoff sotto è già la risposta giusta: qui serve solo
              // dirlo nel menu invece di parlare di errore di rete.
              this._state = "rate-limit";
              this._failures++;
            } else if (err) {
              this._state = "error";
              this._failures++;
            } else {
              this._data = data;
              this._lastUpdate = Date.now();
              this._state = "ok";
              this._failures = 0;
              this._persistData();
            }

            const delay = this._nextDelay(retryAfter);
            this._scheduleAt(this._now() + delay * 1000);
            this._render();

            debug(
              this._state === "ok"
                ? `aggiornato: pannello="${this._label.text}" stato=ok, prossimo fra ${delay}s`
                : `stato=${this._state} (${this._failures} tentativi falliti), prossimo fra ${delay}s`,
            );
          },
        );
      });
    }

    /* La prima richiesta parte solo dopo BOOT_DELAY: chi non ha Claude Code,
     * o non vi ha fatto l'accesso, lo deve sapere subito e non fra minuti.
     * Costa una lettura di file, nessuna richiesta di rete. */
    _checkCredentials() {
      this._reader.read(this._cancellable, (creds) => {
        if (!creds.error || this._pending) return;
        this._state =
          creds.error === "not-installed" ? "not-installed" : "no-credentials";
        this._render();
      });
    }

    /** Claude Code non dà segni di vita da abbastanza da non valere una richiesta. */
    _claudeIsIdle() {
      if (!this._settings.get_boolean("poll-only-when-active")) return false;
      return !this._activity?.activeWithin(ACTIVITY_WINDOW * 1000);
    }

    /* --- pausa quando l'utente non c'è ---
     *
     * Interrogare l'API mentre nessuno guarda il pannello è traffico buttato,
     * ed è proprio quello che riempie la quota nelle ore in cui il computer
     * resta acceso da solo. */
    _watchIdle() {
      try {
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(
          IDLE_PAUSE_SECONDS * 1000,
          () => this._onIdle(),
        );
      } catch (e) {
        // Senza idle monitor si continua a interrogare come prima: nessun danno.
        debug(`idle monitor non disponibile: ${e}`);
        this._idleMonitor = null;
      }
    }

    _onIdle() {
      if (this._idle) return;
      this._idle = true;
      debug("utente inattivo: polling sospeso");

      if (this._pollId) {
        GLib.Source.remove(this._pollId);
        this._pollId = 0;
      }

      // Le watch di risveglio sono a scatto singolo: Meta le rimuove da sé.
      this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
        this._activeWatchId = 0;
        this._idle = false;
        debug("utente tornato: polling ripreso");
        this._requestSoon("wake");
      });
    }

    /* --- copie dell'indicatore sugli altri schermi ---
     *
     * Estensioni come Multi Monitor Bar rifanno la barra sugli schermi non
     * primari e ci mettono un pulsante che clona il nostro contenuto. È un
     * attore diverso dal nostro, quindi il nostro `hover` non si accorgeva di
     * niente e lì il menu si apriva solo al click. Le copie vengono cercate
     * nell'albero della shell e poi trattate come fossero l'indicatore. */

    _scheduleMirrorScan() {
      if (this._mirrorScanId) GLib.Source.remove(this._mirrorScanId);

      this._mirrorScanId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        MIRROR_SCAN_DELAY,
        () => {
          this._mirrorScanId = 0;
          this._rescanMirrors();
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _rescanMirrors() {
      for (const mirror of this._mirrors) this._detachMirror(mirror);
      this._mirrors = [];

      const found = [];
      const visit = (actor, depth) => {
        if (depth > MIRROR_SCAN_DEPTH) return;
        for (const child of actor.get_children()) {
          if (this._isMirrorOf(child)) found.push(child);
          else visit(child, depth + 1);
        }
      };

      try {
        visit(Main.layoutManager.uiGroup, 0);
      } catch (e) {
        debug(`scansione delle copie non riuscita: ${e}`);
        return;
      }

      for (const actor of found) {
        this._mirrors.push({
          actor,
          ids: [
            actor.connect("notify::hover", () => this._onHoverChanged(actor)),
            actor.connect("destroy", () => this._forgetMirror(actor)),
          ],
        });
      }

      debug(`copie dell'indicatore trovate: ${this._mirrors.length}`);
    }

    /** `actor` è un pulsante di pannello che riproduce questo indicatore. */
    _isMirrorOf(actor) {
      if (actor === this) return false;

      // Multi Monitor Bar tiene in chiaro il riferimento all'originale.
      if (actor._sourceIndicator === this) return true;

      // In generale: un pulsante che contiene un clone di un nostro attore.
      return (
        actor instanceof PanelMenu.Button && this._holdsCloneOfUs(actor, 0)
      );
    }

    _holdsCloneOfUs(actor, depth) {
      if (depth > MIRROR_SCAN_DEPTH) return false;

      for (const child of actor.get_children()) {
        if (child instanceof Clutter.Clone && this._contains(child.source))
          return true;
        if (this._holdsCloneOfUs(child, depth + 1)) return true;
      }
      return false;
    }

    _contains(actor) {
      for (let a = actor; a; a = a.get_parent()) if (a === this) return true;
      return false;
    }

    /* La copia sparisce quando l'altra estensione rifà i suoi pannelli. Va tolta
     * dalla lista subito, dentro il segnale `destroy`: dopo, ogni accesso
     * all'attore solleverebbe «already disposed» — e la lista viene letta a
     * ogni giro del controllo sul puntatore. */
    _forgetMirror(actor) {
      this._mirrors = this._mirrors.filter((m) => m.actor !== actor);
      this._cancelHoverOpen();
      this._scheduleMirrorScan();
    }

    _detachMirror(mirror) {
      // L'attore può essere già stato distrutto dall'altra estensione.
      try {
        for (const id of mirror.ids) mirror.actor.disconnect(id);
      } catch (e) {
        debug(`copia già sparita: ${e}`);
      }
    }

    /**
     * Il dato in cache non descrive più la finestra corrente, e mostrarne la
     * percentuale ingannerebbe: o è passato il reset della sessione da 5 ore, o
     * è cambiato il giorno da quando l'abbiamo letto. Ci si arriva quando il
     * token scade a Claude Code fermo — nessun aggiornamento riesce e l'ultimo
     * valore noto invecchia in silenzio. Non è uno `_state`, che registra
     * l'esito delle richieste: è una condizione che matura col solo passare del
     * tempo, e il tick da 30 secondi la fa comparire da sé.
     */
    _dataExpired(tz) {
      if (!this._data || !this._lastUpdate) return false;

      const resetsAt = this._data.session?.resetsAt ?? null;
      if (resetsAt !== null && resetsAt <= Date.now()) return true;

      return !Fmt.isSameDay(this._lastUpdate, Date.now(), tz);
    }

    _render() {
      const tz = this._timeZone();
      const expired = this._dataExpired(tz);
      const session = expired ? null : (this._data?.session ?? null);

      // --- pannello ---
      const parts = [];
      if (session) {
        if (this._settings.get_boolean("show-percent"))
          parts.push(Fmt.formatPercent(session.percent));
        if (this._settings.get_boolean("show-countdown"))
          parts.push(Fmt.formatCountdown(session.resetsAt));
      }

      if (parts.length > 0) this._label.text = parts.join(" · ");
      else if (session)
        this._label.text = ""; // entrambe le voci disattivate: resta la sola icona
      else if (
        this._state === "no-credentials" ||
        this._state === "not-installed"
      )
        this._label.text = "—";
      else this._label.text = "…";

      for (const cls of SEVERITY_CLASSES)
        this._label.remove_style_class_name(cls);
      this._label.remove_style_class_name("claude-usage-dimmed");

      if (this._state !== "ok" || expired) {
        this._label.add_style_class_name("claude-usage-dimmed");
      } else if (session) {
        const level = this._severityLevel(session.percent, session.severity);
        this._label.add_style_class_name(SEVERITY_CLASSES[level]);
      }

      // --- menu ---
      if (session) {
        this._sessionBlock.actor.show();
        this._sessionBlock.update(
          session,
          tz,
          this._severityLevel(session.percent, session.severity),
        );
      } else {
        this._sessionBlock.actor.hide();
      }

      const weekly = expired ? [] : (this._data?.weekly ?? []);
      if (weekly.length !== this._weeklyBlocks.length) {
        this._weeklyBlocks.forEach((b) => b.destroy());
        this._weeklyBlocks = weekly.map(() => {
          const block = new LimitBlock();
          this._weeklyBox.add_child(block.actor);
          return block;
        });
      }
      weekly.forEach((limit, i) => {
        this._weeklyBlocks[i].update(
          limit,
          tz,
          this._severityLevel(limit.percent, limit.severity),
        );
      });

      this._footer.text = this._footerText(tz, expired);
      this._refreshItem.label.text =
        this._state === "rate-limit" ? _("Refresh forzato") : _("Aggiorna ora");
    }

    _footerText(tz, expired) {
      const plan = this._plan ? _("Piano: {0}", this._plan) : null;
      const withPlan = (status) => (plan ? `${plan}\n${status}` : status);

      /* Con il dato scaduto il menu resta senza barre: «Aggiornato alle …»
       * sarebbe la stessa bugia che il pannello ha appena smesso di raccontare.
       * Gli altri stati dicono già da sé perché non c'è niente da mostrare. */
      if (expired && (this._state === "ok" || this._state === "cached")) {
        return withPlan(
          _(
            "Ultimo dato {0} non più valido — in attesa di un aggiornamento",
            Fmt.formatResetTime(this._lastUpdate, tz),
          ),
        );
      }

      let status;
      switch (this._state) {
        case "not-installed":
          status = _("Claude Code non installato");
          break;
        case "no-credentials":
          status = _("Credenziali non trovate — accedi con Claude Code");
          break;
        case "stale":
          status = _("Token scaduto — apri Claude Code per rinnovarlo");
          break;
        case "rate-limit": {
          const wait = Math.max(
            0,
            Math.round((this._nextAllowedAt - this._now()) / 1000),
          );
          const when =
            wait >= 60 ? _("{0} min", Math.round(wait / 60)) : _("{0} s", wait);
          status = _(
            "Troppe richieste — riprovo fra {0} (ultimo: {1})",
            when,
            Fmt.formatClock(this._lastUpdate, tz),
          );
          break;
        }
        case "error":
          status = _(
            "Aggiornamento non riuscito (ultimo: {0})",
            Fmt.formatClock(this._lastUpdate, tz),
          );
          break;
        case "cached":
          status = _(
            "Ultimo dato noto delle {0} — aggiornamento in attesa",
            Fmt.formatClock(this._lastUpdate, tz),
          );
          break;
        case "loading":
          status = _("Caricamento…");
          break;
        default:
          status = _("Aggiornato alle {0}", Fmt.formatClock(this._lastUpdate, tz));
      }

      return withPlan(status);
    }

    destroy() {
      if (this._menuOpenStateId) {
        this.menu.disconnect(this._menuOpenStateId);
        this._menuOpenStateId = 0;
      }
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
      }
      if (this._pollId) {
        GLib.Source.remove(this._pollId);
        this._pollId = 0;
      }
      if (this._tickId) {
        GLib.Source.remove(this._tickId);
        this._tickId = 0;
      }
      if (this._mirrorScanId) {
        GLib.Source.remove(this._mirrorScanId);
        this._mirrorScanId = 0;
      }
      if (this._monitorsChangedId) {
        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;
      }
      if (this._extensionStateId) {
        Main.extensionManager.disconnect(this._extensionStateId);
        this._extensionStateId = 0;
      }
      for (const mirror of this._mirrors) this._detachMirror(mirror);
      this._mirrors = [];

      if (this._idleMonitor) {
        if (this._idleWatchId)
          this._idleMonitor.remove_watch(this._idleWatchId);
        if (this._activeWatchId)
          this._idleMonitor.remove_watch(this._activeWatchId);
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idleMonitor = null;
      }

      this._cancelHoverOpen();
      this._stopHoverWatch();

      this._cancellable.cancel();
      this._cancellable = null;

      this._reader.destroy();
      this._reader = null;
      if (this._windowDestroyId) {
        global.window_manager.disconnect(this._windowDestroyId);
        this._windowDestroyId = 0;
      }
      if (this._closedCheckId) {
        GLib.Source.remove(this._closedCheckId);
        this._closedCheckId = 0;
      }
      this._stopIconAnimation();
      this._turns.destroy();
      this._turns = null;
      this._activity.destroy();
      this._activity = null;
      this._client.destroy();
      this._client = null;

      this._weeklyBlocks = [];
      this._settings = null;
      this._data = null;

      super.destroy();
    }
  },
);

export default class ClaudeUsageExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._zone = null;
    this._zoneIds = null;
    this._repositionId = 0;
    this._moves = [];
    setLanguage(this._settings.get_string("language"));
    this.notifier = new TurnNotifier(this.path);
    this._create();

    /* Spostare l'indicatore richiede di ri-aggiungerlo al pannello; cambiare
     * lingua di ricostruirne il menu, e ricrearlo fa entrambe le cose. */
    this._placementIds = [
      "changed::panel-position",
      "changed::panel-index",
      "changed::language",
    ].map((signal) =>
      this._settings.connect(signal, () => {
        setLanguage(this._settings.get_string("language"));
        this._recreate();
      }),
    );
  }

  _create() {
    this._indicator = new ClaudeIndicator(this);
    debug("indicatore costruito e aggiunto al pannello");
    Main.panel.addToStatusArea(
      this.uuid,
      this._indicator,
      this._settings.get_int("panel-index"),
      this._settings.get_string("panel-position"),
    );
    this._watchZone();
  }

  _recreate() {
    this._unwatchZone();
    this._indicator?.destroy();
    this._indicator = null;
    this._create();
  }

  /* --- la posizione va mantenuta, non solo impostata ---
   *
   * `addToStatusArea` mette l'indicatore all'indice scelto, ma è un fatto che
   * dura il tempo che dura: nella stessa zona continuano ad arrivare altri, e
   * chi si inserisce prima di noi ci sposta di un posto verso destra. Dopo il
   * login ne arrivano parecchi — le icone di AppIndicator man mano che i
   * programmi in vassoio partono, gli elementi della shell rimessi in fila a
   * ogni cambio di modalità di sessione — e a fine avvio l'indicatore non sta
   * più dove dice l'impostazione: da qui il «l'ho salvato a 0 e al riavvio lo
   * trovo a destra». Cambiare l'impostazione a sessione avviata sembrava
   * funzionare solo perché lì la ricreazione arriva dopo tutti gli altri.
   *
   * Perciò la zona viene osservata: a ogni vicino che compare o sparisce
   * l'indicatore torna al suo indice. */

  _watchZone() {
    const zone = this._indicator?.container?.get_parent();
    if (!zone) {
      debug("zona del pannello non trovata: posizione non sorvegliata");
      return;
    }

    this._zone = zone;
    this._moves = [];
    this._zoneIds = ["child-added", "child-removed"].map((signal) =>
      zone.connect(signal, () => this._scheduleReposition()),
    );
  }

  _unwatchZone() {
    if (this._repositionId) {
      GLib.Source.remove(this._repositionId);
      this._repositionId = 0;
    }

    this._zoneIds?.forEach((id) => this._zone.disconnect(id));
    this._zoneIds = null;
    this._zone = null;
  }

  /** Un inserimento nella zona ne porta dietro altri: si aspetta la raffica. */
  _scheduleReposition() {
    if (this._repositionId) return;

    this._repositionId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PLACEMENT_SETTLE_DELAY,
      () => {
        this._repositionId = 0;
        this._reposition();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  /** Riporta l'indicatore all'indice scelto, se un vicino gliel'ha cambiato. */
  _reposition() {
    const container = this._indicator?.container;
    if (!container || !this._zone || container.get_parent() !== this._zone)
      return;

    const children = this._zone.get_children();
    const target = Math.min(
      this._settings.get_int("panel-index"),
      children.length - 1,
    );
    if (target < 0 || children.indexOf(container) === target) return;

    /* Se un'altra estensione pretende lo stesso posto e lo rivendica come
     * facciamo noi, i due se lo scambierebbero all'infinito: meglio un
     * indicatore fuori posto che un pannello che sfarfalla. */
    const now = GLib.get_monotonic_time() / 1000;
    this._moves = this._moves.filter((t) => now - t < PLACEMENT_MOVES_WINDOW);
    if (this._moves.length >= PLACEMENT_MAX_MOVES) {
      debug("posizione contesa da un'altra estensione: smetto di insistere");
      this._unwatchZone();
      return;
    }
    this._moves.push(now);

    this._zone.set_child_at_index(container, target);
    debug(`indicatore riportato all'indice ${target}`);
  }

  disable() {
    debug("estensione disabilitata: l'indicatore viene distrutto");
    this._placementIds?.forEach((id) => this._settings.disconnect(id));
    this._placementIds = null;

    this._unwatchZone();
    this._indicator?.destroy();
    this._indicator = null;
    this.notifier?.destroy();
    this.notifier = null;
    this._settings = null;
  }
}
