# Spec: a dependency-free D-Bus client for the XDG GlobalShortcuts portal

**Audience:** an agent working on a KDE Plasma 6 / Wayland machine.
**Deliverable:** `electron/portalShortcuts.cjs` — a small D-Bus client, no npm dependencies, plus a
standalone CLI harness so it can be exercised without Electron.

---

## 1. Why this exists

Unhush is a Linux dictation app. It needs one global hotkey to start and stop recording.

On a Wayland session Unhush re-launches itself under XWayland (it must: an unfocused Wayland client
cannot reliably set the clipboard, which is the app's core function). Under XWayland, Chromium
builds an X11 key-grab listener rather than a portal one, and a Wayland compositor does not honour
X11 grabs from an XWayland client — so `globalShortcut` is dead there. The current shipping answer
is a named pipe: the user creates a desktop shortcut that runs `unhush-toggle`, which writes
`toggle` into `$XDG_RUNTIME_DIR/unhush.fifo`. That works, but it is a manual setup step.

Electron's own portal path was tried and is broken: bindings survived a restart, appeared in System
Settings, delivered nothing, and **crashed the app (SIGTRAP — a Chromium `CHECK`)** when a stale one
was pressed. Chromium derives portal shortcut ids locally as `prefix + "-" + accelerator_string`,
with a UUID from its own prefs baked into the prefix, instead of using the ids the portal returns.

**A standalone probe proved the portal itself is fine.** `scripts/portal-shortcut-probe.py` (in this
repo — read it, it is the reference implementation in Python) drives the portal directly and works
where Electron does not. This task is to reimplement that probe's logic in dependency-free
JavaScript so Unhush can bind its hotkey itself on KDE, GNOME and Hyprland Wayland sessions.

D-Bus is transport-agnostic, so this works fine from a process running under XWayland.

## 2. What was measured (Fedora KDE Plasma 6 / Wayland, Sept 2026)

Do not re-litigate these; build to them.

| Probe run | Result |
|---|---|
| `bind` (first ever) | Consent dialog on Plasma 6, then armed and delivering |
| `listen` (new session, `ListShortcuts` only, no bind) | Shortcut **listed but not armed** — the key still reaches the focused window |
| `rebind` (new session, `BindShortcuts` with the same id) | Armed and delivering, no prompt |
| `rebind` with a **different** `preferred_trigger` | **Old trigger wins.** New key never captured, old key still fires, and **no second binding is created** |
| `configure` | Opens System Settings focused on our app. **Add+** captures *additional* keys for the same shortcut, and each trigger has its own checkbox — unchecking the app-supplied default leaves user-added keys active and working. Triggers can be disabled but not deleted; only the whole app entry can be removed |

Consequences that shape the design:

1. **Call `BindShortcuts` on every launch.** Restoring a session does not re-arm anything.
2. **Use one stable shortcut id** (e.g. `toggle-recording`). One id ⇒ exactly one binding, ever.
   Chromium's accelerator-as-id scheme is what produced a permanent stale binding per key tried.
3. **An app cannot change its own shortcut after the first bind.** `preferred_trigger` is a
   suggestion honoured once. Changing the key must go through
   `ConfigureShortcuts`, which opens the desktop's own editor.
4. There is **no unbind** anywhere in the interface. Do not look for one.
5. **Changing the key is the user's job, through `ConfigureShortcuts`, and the model is additive
   — measured and confirmed on Plasma 6.** The user adds a key with Add+ and unchecks the
   app-supplied default; the added key stays active and fires. `Activated` carries the shortcut
   **id**, so every trigger bound to `toggle-recording` invokes the same handler and the app never
   needs to know which key fired. Never track "which key is ours" — that is the mistake Chromium
   made in a different form.

   Consequently the app's `preferred_trigger` is a *starting point*, not a commitment: it works out
   of the box and the user can disable it once they have chosen their own. Pick a conservative
   default anyway, since it is visible in their settings for the life of the install.
6. **A shortcut with every trigger disabled is listed but unarmed** — the same state the `listen`
   run produced, and silent. `BindShortcuts` returns `trigger_description` per shortcut, so an
   empty value is detectable; surface it rather than leaving the user with a dead key.

## 3. Constraints

- **No npm dependencies.** Node built-ins only (`net`, `os`, `crypto` if useful). This app currently
  has zero runtime dependencies and that is worth keeping. `dbus-next` pulls a native addon;
  `dbus-native` is pure JS but would be the first runtime dep — both were rejected.
- **CommonJS `.cjs`**, matching `electron/*.cjs`. No TypeScript in this directory.
- **No Electron imports.** Take a logger via `init(log)` like the sibling modules
  (`electron/ydotool.cjs`, `electron/waylandShortcut.cjs` — follow their shape and comment style).
- **Must run standalone under plain `node`.** This is the main testability requirement.
- Fail soft: no portal, no interface, no consent → log and return "unavailable" so the caller falls
  back to the existing pipe. Never throw into the app.

## 4. D-Bus protocol — enough detail to implement without guessing

### 4.1 Connect

Read `DBUS_SESSION_BUS_ADDRESS`, e.g. `unix:path=/run/user/1000/bus`, possibly with extra
comma-separated key=value pairs, and possibly `unix:abstract=/tmp/dbus-XXXX` instead. For an
abstract socket, Node connects with a path whose first character is `\0`.

### 4.2 Authenticate (SASL, line-based text)

1. Send a single `\0` byte — required, and not part of any line.
2. Send `AUTH EXTERNAL <hex>\r\n`, where `<hex>` is the *ASCII decimal uid, hex-encoded*: uid 1000 →
   the string `"1000"` → `31303030`.
3. Expect `OK <server-guid>\r\n`.
4. Send `BEGIN\r\n`. Binary messages follow. (`NEGOTIATE_UNIX_FD` is not needed; we pass no fds.)

### 4.3 Message framing

Every message: a fixed 12-byte header, then a header-field array, then the body.

```
byte  0      endianness: 'l' (0x6C) little-endian. Marshal little-endian throughout.
byte  1      type: 1=METHOD_CALL 2=METHOD_RETURN 3=ERROR 4=SIGNAL
byte  2      flags: 0 is fine (0x1 = NO_REPLY_EXPECTED)
byte  3      protocol version: 1
bytes 4-7    uint32 body length in bytes (excludes header and its padding)
bytes 8-11   uint32 serial, starts at 1, increments, never 0
bytes 12..   header fields, an array of (byte, variant): signature `a(yv)`
             then PAD TO AN 8-BYTE BOUNDARY, then the body
```

Header field codes: `1`=PATH(`o`), `2`=INTERFACE(`s`), `3`=MEMBER(`s`), `4`=ERROR_NAME(`s`),
`5`=REPLY_SERIAL(`u`), `6`=DESTINATION(`s`), `7`=SENDER(`s`), `8`=SIGNATURE(`g`).

**Alignment is the thing that will bite you.** Every value aligns to its natural boundary *measured
from the start of the message*, with zero padding inserted before it:

| Type | Code | Align | Encoding |
|---|---|---|---|
| byte | `y` | 1 | one byte |
| uint32 | `u` | 4 | 4 bytes LE |
| uint64 | `t` | 8 | 8 bytes LE |
| string | `s` | 4 | uint32 byte length (excluding NUL), bytes, then a NUL |
| object path | `o` | 4 | same as string |
| signature | `g` | 1 | **1-byte** length, bytes, then a NUL |
| array | `a` | 4 | uint32 byte length **of the contents only**, then pad to the element's alignment, then elements |
| struct | `(...)` | 8 | fields in order |
| dict entry | `{kv}` | 8 | key then value |
| variant | `v` | 1 | signature (as `g`), then the value at *its* alignment |

Two classic mistakes: the array's length counts contents but *excludes* the padding between the
length and the first element; and a struct inside an array still aligns to 8.

Reads can split anywhere, so buffer incoming bytes and only parse once you have
`align8(12 + 4 + header_array_len) + body_len` available.

### 4.4 Bootstrapping

- First call must be `Hello` on `org.freedesktop.DBus` at `/org/freedesktop/DBus`, interface
  `org.freedesktop.DBus`. The reply (`s`) is your unique name, e.g. `:1.234`. You need it in §5.1.
- To receive signals you must call `AddMatch` (same destination/interface) with a rule string, e.g.
  `type='signal',sender='org.freedesktop.portal.Desktop'`. Without it the bus delivers nothing.
- Correlate replies via the REPLY_SERIAL header field. Handle type 3 (ERROR) by rejecting with the
  ERROR_NAME plus the first body string.

## 5. The portal API

Destination `org.freedesktop.portal.Desktop`, path `/org/freedesktop/portal/desktop`, interface
`org.freedesktop.portal.GlobalShortcuts`. Read the interface docs:
<https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html>

Check availability first with `org.freedesktop.DBus.Properties.Get(SHORTCUTS_IFACE, "version")` — a
`Get` error means no GlobalShortcuts backend (`xdg-desktop-portal-wlr` and `-gtk` don't implement
it). `ConfigureShortcuts` requires version ≥ 2.

### 5.1 The Request pattern

Most methods return an object path for a `Request`, and the *result* arrives later as an
`org.freedesktop.portal.Request::Response` signal at that path, with body `(u results)` where `u` is
0=success, 1=cancelled by user, 2=ended some other way.

Supply your own `handle_token` in the options dict, so the path is predictable:

```
/org/freedesktop/portal/desktop/request/<SENDER>/<handle_token>
```

where `<SENDER>` is your unique name with the leading `:` removed and every `.` replaced by `_`
(`:1.234` → `1_234`). **Install the match and start listening before making the call** — a fast
portal can answer before you would otherwise be watching. Token must be a valid object-path element:
`[A-Za-z0-9_]`.

### 5.2 Calls needed

```
CreateSession(options a{sv}) -> request
    options: handle_token (s), session_handle_token (s)
    Response results contain session_handle -- typed as STRING, not object path
    (a documented quirk kept for backwards compatibility)

BindShortcuts(session o, shortcuts a(sa{sv}), parent_window s, options a{sv}) -> request
    shortcuts: [(id, { description: s, preferred_trigger: s })]
    parent_window: "" is accepted and works
    preferred_trigger uses the XDG shortcuts spec syntax, NOT Electron accelerators:
    "CTRL+ALT+space", not "Ctrl+Alt+Space"
    Response results contain shortcuts: [(id, { description, trigger_description })]

ListShortcuts(session o, options a{sv}) -> request
    Diagnostic only. Confirmed NOT to arm anything.

ConfigureShortcuts(session o, parent_window s, options a{sv})
    Plain method call: no OUT parameter, no Response signal. The editor appears or it doesn't.
    The session must have bound shortcuts, or there is nothing to show.
```

Signals on the GlobalShortcuts interface, all at the portal path:

```
Activated(session o, shortcut_id s, timestamp t, options a{sv})
Deactivated(session o, shortcut_id s, timestamp t, options a{sv})
ShortcutsChanged(session o, shortcuts a(sa{sv}))
```

Dispatch on `shortcut_id` from the signal — **never on a locally reconstructed id.** Using
locally-derived ids is the exact bug this work exists to avoid.

### 5.3 Sequence per launch

```
connect -> auth -> Hello -> AddMatch
check GlobalShortcuts version          (absent -> report unavailable, caller falls back)
CreateSession                          -> session handle
BindShortcuts([{ id: "toggle-recording", description, preferred_trigger }])
subscribe Activated -> invoke the callback when shortcut_id === "toggle-recording"
```

Hold the connection open for the life of the process. **The session dies with the connection** —
that is why `gdbus call` cannot be used for this and why a persistent client is required.

## 6. Module API

```js
const portal = require("./portalShortcuts.cjs");
portal.init(log);                                   // log(level, message), as in the sibling modules

await portal.start({
  id: "toggle-recording",
  description: "Start or stop dictation",
  preferredTrigger: "CTRL+ALT+space",               // honoured on first bind only
  onActivated: () => { /* toggle recording */ },
});
// -> { ok: true } | { ok: false, reason: "unavailable" | "denied" | "error", error?: string }

portal.isAvailable();          // boolean, after start()
await portal.configure();      // ConfigureShortcuts: hands the user to the desktop's editor
portal.stop();                 // close the session and the connection
```

`start()` should return the bound trigger(s) alongside `ok`, taken from the `BindShortcuts`
response's `trigger_description` — the UI displays what the desktop actually assigned rather than
what we asked for, and an empty value means no key is assigned (see §2.6).

A full reset — clearing the binding so a fresh `preferred_trigger` is honoured again — requires the
user to delete the whole app entry in their desktop's shortcut settings, after which the next
`BindShortcuts` is a first bind. Document it; do not make it the routine path for changing a key.

`start()` must never throw and must never hang forever — bound every wait (the consent dialog is a
human in the loop; 120 s is what the Python probe uses).

## 7. Standalone test harness — the primary acceptance requirement

Ship a CLI in the same file (or `scripts/portal-client-probe.cjs`) mirroring the Python probe, so it
runs with **no Electron and no build step**:

```bash
node electron/portalShortcuts.cjs bind [TRIGGER]     # create, bind, wait for presses
node electron/portalShortcuts.cjs listen             # create, list only, wait
node electron/portalShortcuts.cjs rebind [TRIGGER]   # create, bind same id again, wait
node electron/portalShortcuts.cjs configure          # bind, then open the desktop's editor
```

**Acceptance: the JS client must reproduce the Python probe's results exactly**, run side by side on
the same machine:

| Run | Required outcome |
|---|---|
| `bind` first time | Consent dialog, then presses print `Activated` lines |
| `listen` | Lists the shortcut; presses do **not** arrive (key reaches the focused window) |
| `rebind` same key | No prompt; presses arrive |
| `rebind` different key | Old trigger reported and still firing; new key inert; still one entry in System Settings |
| `configure` | KDE's editor opens showing our shortcut; a key added with Add+ fires the same id, and unchecking the default leaves the added key working |
| No portal (e.g. run it on X11/GNOME-Xorg) | Clean "unavailable" message, no crash, no hang |

Add unit tests for the marshalling under `electron/portalShortcuts.test.ts` (vitest, `// @vitest-environment node`,
following `electron/commandFifo.test.ts`). Marshalling is pure and deserves it: round-trip
`a{sv}`, `a(sa{sv})`, nested variants, and — most importantly — **assert exact byte offsets and
padding** for a known message, since alignment bugs are the failure mode here and they produce
confusing runtime errors rather than obvious ones.

## 8. Landmines

1. **The session dies with the connection.** One connection, held open.
2. **`AddMatch` before the call**, or the Response is missed.
3. **`Hello` first**, before any other traffic.
4. **Signature `g` uses a 1-byte length**, unlike `s`/`o` which use uint32.
5. **`session_handle` comes back as `s`, not `o`** — but `BindShortcuts` takes it as `o`. Convert.
6. **Trigger syntax is the XDG shortcuts spec, not Electron's.** `CTRL+ALT+space`.
7. **Never derive shortcut ids locally.** Use what the portal sends.
8. Sockets deliver partial messages. Frame properly before parsing.
9. Don't bind more than one id: each armed shortcut is a global grab taken from the user's system.
   (`Shift+Space` in particular must never be bound globally — it fires during ordinary typing.)
10. `BindShortcuts` may be called only **once per session**. Changing anything means a new session.

## 9. Out of scope

Integration into Unhush's UI. Land the module and the harness first, verified against the table in
§7. Wiring it into `electron/main.cjs`, replacing the Settings shortcut dropdown with a "Change
shortcut…" button backed by `configure()`, and keeping the fifo as the fallback for sway/wlroots and
X11, all come after — and the fifo stays regardless, since `xdg-desktop-portal-wlr` and `-gtk` do not
implement this interface.

## 10. Reference material in this repo

- `scripts/portal-shortcut-probe.py` — working Python reference, all four modes, measured results in
  its header comment.
- `electron/commandFifo.cjs` — the existing pipe mechanism, and the module/comment style to match.
- `electron/waylandShortcut.cjs` — where a portal client would eventually be wired in.
