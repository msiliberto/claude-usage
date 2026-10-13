# Claude Usage — GNOME Shell extension

🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

Shows in the top bar how much of your Claude usage limits you have used, without
having to open a Claude Code session and type `/usage`.

```
 …  ✳ 19% · 2h46   📶 🔋 54%
```

- **`19%`** — usage of the 5-hour session
- **`2h46`** — time left until that session resets

Hovering over the indicator opens a menu with weekly usage, progress bars and
the **exact reset times in the Rome time zone**; it closes by itself when the
pointer moves away. Clicking the indicator intentionally does nothing: opening
and closing is handled by hover alone, and to fetch fresh data right away there
is «Refresh now» in the menu.

> The interface is in Italian or English, selectable in the preferences
> (default: Italian). Unofficial extension, not affiliated with Anthropic.

## How it works

It queries `https://api.anthropic.com/api/oauth/usage`, the same endpoint behind
`/usage` in Claude Code, using the OAuth token that Claude Code already keeps in
`~/.claude/.credentials.json`.

The file is **only read, never written**: there is no way for the extension to
invalidate your login. When the token expires, the indicator turns grey and
shows the last known value; as soon as you reopen Claude Code the token is
renewed and a `FileMonitor` restarts the updates on its own. (Besides, if Claude
Code is not running, your usage is not changing anyway.)

A known value does not stay valid forever, though. Once the 5-hour session reset
time has passed, or simply when the day has changed, that percentage no longer
describes anything: the panel goes back to `…` and the menu shows no bars,
instead of keeping a number from yesterday on display as if it were current.

Reset times come from the API in UTC and are explicitly converted to
`Europe/Rome`, with the correct DST offset for the reset date.

If `~/.claude` does not exist at all, Claude Code has never run on this
computer, and the menu says so («Claude Code not installed»). If the folder
exists but the credentials file does not, it asks you to log in with Claude
Code.

### Avoiding rate limits (HTTP 429)

The endpoint throttles requests that come too close together, and you hit that
limit much sooner than the refresh interval alone would suggest: requests come
from three different places — polling, Claude Code rewriting
`.credentials.json`, and the «Refresh now» command.

They all go through a single point, which keeps only one attempt scheduled at a
time: a source can at most bring it forward, never add another one. Opening the
menu, on the other hand, **no longer requests anything**: with hover it happens
every time the mouse passes over it, which is far too frequent to cost a
request.

- two requests are never less than **60 seconds** apart;
- after a 429 it waits **5 minutes**, then 10, then 15 at most — nothing gets
  through during that window, and the button becomes «Force refresh»: clicking
  it sends the request anyway, at your own risk (insisting can extend the
  block);
- the refresh interval is set in minutes, minimum **3**;
- after **5 minutes** of session inactivity polling stops completely and
  resumes, with an immediate update, as soon as you are back at the computer;
- **nothing is requested while Claude Code is idle**: see below.

Under a rate limit, the menu tells you how long until the next attempt.

> `Retry-After` is honoured when it makes sense, but don't count on it: this
> endpoint's 429 comes from the Cloudflare edge and carries `retry-after: 0`,
> which says nothing. In that case the local backoff is in charge.

#### Only asking when there is something to learn

Usage only changes while Claude Code is working. With the session idle the API
would return the same number every time, and every request would be quota
burned for nothing — including all the ones during the hours the computer stays
on while you are not doing anything.

Claude Code rewrites its transcript in
`~/.claude/projects/<project>/<session>.jsonl` **on every message**: it is the
only file that changes continuously, so it is the most direct activity signal
there is. `lib/activity.js` puts a `FileMonitor` on each project folder (the 32
most recent, to avoid an avalanche of inotify watches) and only records _when_
something was touched: deciding whether to query the API does not require
opening the file. Only the [sessions](#claude-code-sessions-the--tells-you-where-you-are)
feature reads it, read-only.

If no activity has been seen for **10 minutes**, the periodic poll is skipped
and retried later, without touching the network. Startup and «Refresh now» are
always allowed, since those are your own requests.

> It can be turned off in the preferences. **Do so if you use Claude from the
> browser**: there is no local transcript to watch there, usage changes without
> this machine noticing, and the panel would stay on `…` until you press
> «Refresh now».

#### The gate outlives the indicator

Containing requests **inside** the indicator is not enough, because the
indicator is not permanent: the shell destroys and rebuilds it on every session
mode change, and after login this happens several times in a row — three times
in two minutes, in one measured case. Each instance started with its counters
at zero and the first thing it did was request fresh data: **that** was the
burst that led to the 429, not polling.

So the time of the last request, the backoff deadline, the accumulated failures
and the last good data are stored in GSettings (keys `last-request`,
`retry-until`, `backoff-failures`, `cached-usage`, `cached-at`: state, not
preferences). A freshly built indicator inherits the ongoing wait and
immediately shows the cached value instead of fetching it again; the limiting
also survives a shell restart.

### With multiple monitors

Extensions like [Multi Monitor
Bar](https://extensions.gnome.org/extension/8236/multi-monitors-bar/) rebuild the
bar on non-primary monitors, and put there a **button that clones** this
indicator: since it is a different actor, our `hover` did not notice it, and on
the second monitor the menu did not open at all.

The extension now looks for its own copies in the shell's actor tree —
recognising them either by their reference to the original or, more generally,
by the clone they contain — and treats them like the indicator itself: hover,
opening and automatic closing work on every monitor, with the menu anchored to
the copy the pointer came from. The search is repeated when monitors change or
when an extension is enabled or reloaded; if no copies are found, nothing
changes.

### The position in the panel area must be kept, not just set

Placing the indicator at the chosen index only lasts as long as it lasts: other
items keep arriving in the same area, and anything inserted before us pushes us
one place to the right. Quite a few arrive after login — AppIndicator icons as
tray programs start, shell items being re-queued on every session mode change —
and once startup was over the indicator was no longer where the setting said.
That was the «I saved it at 0 and after a restart it's on the right» issue:
changing the setting with the session already running only seemed to work
because the re-creation then happens after everyone else.

The area is therefore watched: every time a neighbour appears or disappears, the
indicator goes back to its index (or to the last available slot, if the area
has shrunk). If another extension claimed the same slot the same way, the two
would swap places forever: after about forty moves in ten seconds it gives up,
because a misplaced indicator is better than a flickering panel.

## Claude Code sessions: the ✳ tells you where you are

The same transcripts also tell _where_ a turn is, and the ✳ in the panel shows
it:

| ✳ | Meaning |
|---|---|
| white, still | no session running |
| slowly rotating | Claude is working |
| **green** | finished — until you hover over the indicator |
| **green**, rotating | one chat has finished, another is still working |
| **orange**, pulsing | waiting for you — takes priority over everything else |

With several chats, in the same VS Code window or in different ones, the colour
is that of the most urgent one and the rotation tells you something is still
working: a chat that finishes turns the ✳ green without stopping it.

Below the limits, the menu lists the **VS Code instances**, one row per window
with the name of the open folder: several chats in the same window share a
single row, which describes the most urgent one («Stuck for 4 min on Bash»,
«plan to approve», «Finished at 14:32 · another one working»). Clicking
a row brings that window to the front; if it is not open, the click does
nothing.

Green and orange are kept far from the yellow and red of the usage thresholds,
so «finished» and «waiting for you» are not confused with «you're at 50%»;
colour is not the only signal (rotation, pulsing) and it has a darker variant
for light panels, detected from the text colour the theme gives the panel. The
rotation is stepped — the ✳ has 45° symmetry — so as not to keep the GPU at
60 fps for the whole time Claude is working.

### How it is detected

On every change to a `.jsonl`, `lib/turns.js` reads **only its tail** — from
64 KB up to 4 MB, if a very long tool result has pushed the last message back —
and looks at the model's last message:

| In the transcript | State |
|---|---|
| `stop_reason: "end_turn"` | finished |
| `AskUserQuestion` or `ExitPlanMode` without a result | waiting for you, immediately |
| another tool without a result, file unchanged for 3 minutes | waiting for you (or a long command) |
| `Agent` without a result | working: it's a subagent, which writes elsewhere |
| `[Request interrupted by user…]` | nothing: you stopped it |

No hooks, no lines in `~/.claude/settings.json`: nothing in Claude Code's
configuration is touched, and the transcripts are only read.

The price is the third row. The dialog in which Claude Code asks your
permission for a command **leaves no trace in the transcript**: a `Bash` waiting
for your «allow» and a `Bash` that has been compiling for two minutes look the
same in the file. That is why orange only appears after a delay (configurable,
from 30 seconds to 30 minutes), and the menu mentions both possibilities.

A reopened session does not announce yesterday's turn.

When you close a chat, or VS Code, the session disappears from the menu. Every
open chat is a `claude` process, and `/proc` — also only read — tells which
folder it runs in: the name of the transcript folder in `~/.claude/projects` is
exactly that path, with every character that is not a letter or a digit
replaced by `-`. Once there is no process left on that project, its sessions
leave the list: this is checked on every 30-second tick and, so you don't have
to wait, a couple of seconds after a VS Code window closes.

The check only runs if there is at least one session in the menu — otherwise
there is nothing to remove — and it is not done by the shell: going through
/proc means opening a few hundred files, around ten milliseconds that on the
thread drawing the screen would be enough to drop a frame on 120 Hz monitors.
It is done by a separate `sh`, which filters processes by name alone (`comm`)
and returns the folder and arguments of the few remaining `claude` processes in
a single asynchronous reply; the shell only has to start the process, a couple
of milliseconds. This also works for terminal sessions and for those inside a
Dev Container. With two chats on the same project, closing only one is not
enough to remove it — the two processes are indistinguishable, unless one was
resumed with `--resume` — but closing the window removes both. System
notifications are still available, off by default: they are useful if the
panel stays hidden, for example with a full-screen window.

> The transcript format is internal to Claude Code and undocumented: if a
> future version changes it, the ✳ stops changing state — the usage indicator
> is not affected.

## Installation

Copy and paste the whole block, from any directory: `SRC` is the only thing to
adapt if you move the project.

```bash
# 0. Project path (the only line to change if you move it elsewhere)
SRC=~/Documenti/utilizzo-claudio

# 1. Link the folder into the user's extensions
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$SRC" ~/.local/share/gnome-shell/extensions/claude-usage@msiliberto.github.io

# 2. Compile the GSettings schema (required)
glib-compile-schemas "$SRC/schemas/"

# 3. Log out and back in, then enable the extension
gnome-extensions enable claude-usage@msiliberto.github.io
```

The logout between step 2 and step 3 is **not optional**: on Wayland restarting
the shell with `Alt+F2` → `r` no longer exists, and until the shell rereads the
extensions folder the `enable` command replies that the extension does not
exist.

> Don't use `$PWD` instead of `$SRC`: if you run the command from your home
> folder you end up with a symlink pointing to `/home/<user>` instead of the
> project.

## Development

Testing network, parsing and time zone **without restarting the shell**:

```bash
./tools/run-test.sh              # uses Europe/Rome
./tools/run-test.sh UTC          # checks that the time zone is really applied
```

> The script goes through `tools/run-test.sh` rather than calling `gjs`
> directly because the VS Code terminal installed as a snap sets
> `GIO_MODULE_DIR` to incompatible GIO modules, which break libsoup's TLS
> backend. GNOME Shell runs outside the snap and is not affected.

Testing the UI in a separate shell, without leaving your session:

```bash
env -u XDG_DATA_HOME -u GIO_MODULE_DIR -u GSETTINGS_SCHEMA_DIR \
    XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG" CLAUDE_USAGE_DEBUG=1 \
  dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800
```

Two caveats learned the hard way:

- in GNOME 50 the `--nested` option **no longer exists**; without
  `--display-server` the shell should start nested, but from the VS Code snap
  terminal it cannot attach to the compositor and falls back to display server
  mode (`Failed to take control of the session: EBUSY`). `--headless` mode works
  around this and still loads all the JS;
- `XDG_DATA_HOME` must be unset, otherwise it points inside the snap: the shell
  would read stale GSettings schemas and **would not even find**
  `~/.local/share/gnome-shell/extensions`.

### Diagnostics

With `CLAUDE_USAGE_DEBUG=1` set in the session environment, the extension logs
the outcome of every update:

```bash
journalctl --user -f -o cat | grep -i claude-usage
```

Without the variable it writes nothing to the journal.

## Preferences

`gnome-extensions prefs claude-usage@msiliberto.github.io`

| Setting                                      | Default                                     |
| -------------------------------------------- | ------------------------------------------- |
| Language                                     | Italian (or English)                        |
| Refresh interval                             | 300 s (minimum 180)                         |
| Show percentage / time to reset              | on                                          |
| Only refresh while Claude Code is working    | on                                          |
| Panel area and position                      | right, 0                                    |
| Warning (yellow) / critical (red) threshold  | 50% / 80%                                   |
| Time zone                                    | `Europe/Rome` (empty = system time zone)    |
| Credentials path                             | empty = `~/.claude/.credentials.json`       |

On error the interval doubles at each attempt up to a maximum of 15 minutes,
and goes back to normal on the first success. See
[Avoiding rate limits (HTTP 429)](#avoiding-rate-limits-http-429) for the rest.

## Building the zip

```bash
gnome-extensions pack . \
  --schema=schemas/org.gnome.shell.extensions.claude-usage.gschema.xml \
  --extra-source=lib \
  --extra-source=icons \
  -f
```

## Installing the zip

```bash
# 1. Install the bundle into the user's extensions folder
env -u XDG_DATA_HOME \
  gnome-extensions install --force claude-usage@msiliberto.github.io.shell-extension.zip

# 2. Check that it landed where the shell actually looks for it
ls -d ~/.local/share/gnome-shell/extensions/claude-usage@msiliberto.github.io

# 3. Log out and back in (on Wayland there is no alternative)

# 4. Enable it
env -u XDG_DATA_HOME \
  gnome-extensions enable claude-usage@msiliberto.github.io
```

The `env -u XDG_DATA_HOME` is **not optional in the VS Code terminal**: the snap
sets `XDG_DATA_HOME=~/snap/code/<rev>/.local/share`, so `gnome-extensions
install` extracts the extension in there, exits successfully, and GNOME Shell
never sees it. The symptom is exactly "extension does not exist" at step 4,
even after logging out — and if step 2 prints nothing, that is what happened.

This applies to **both** commands: `enable` also resolves the extensions folder
from `XDG_DATA_HOME`, so when run from the snap terminal it looks for the
extension inside `~/snap/code/<rev>/...` and replies that it does not exist even
though it was installed correctly.

Outside the snap (GNOME Terminal, Konsole, a normal SSH session) `XDG_DATA_HOME`
is empty and `env -u` does nothing: it is harmless to keep it, so if you pass
the zip to someone else it is best to give them the commands in this form,
without knowing which terminal they will run them from.

## Publishing on extensions.gnome.org

1. Build the zip as above (the schema goes into the zip as `.xml`: since GNOME
   44 the shell compiles it itself, and `gschemas.compiled` must not be
   included).
2. Upload it from <https://extensions.gnome.org/upload/> with your account.
3. Follow the review from the extension's page: reviewers reply there.

The `version` field in `metadata.json` is reassigned by the site on every
upload; the one shown to users is `version-name`.

## License

GPL-2.0-or-later, see [LICENSE](LICENSE). Unofficial extension, not affiliated
with Anthropic; Claude is a trademark of Anthropic, PBC.
