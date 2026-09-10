[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-working,_but_unmaintained-blue.svg)]()

# dbus-portal-client

Dependency-free D-Bus client (Node built-ins only) for the [XDG GlobalShortcuts
portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
 (a part of the xdg-desktop-portal) plus a Python reference probe. Lets an app bind a global hotkey
on KDE/GNOME/Hyprland Wayland sessions — including from an XWayland process, since D-Bus is transport-agnostic 
— without other tools, a native addon (`dbus-next`) or a first runtime dependency (`dbus-native`). It may 
also be a useful lightweight example of using D-Bus without heavy dependencies for other xdg interfaces.

## How to use the shortcuts portal (based on testing with KDE Plasma 6 / Wayland)

- Call `BindShortcuts` on every launch. `ListShortcuts` alone does not re-arm a restored session —
  failing this, the shortcut is listed but the key still reaches the focused window (so is not captured globally).
- Use one stable shortcut id for the app's lifetime. One id yields exactly one binding, ever.
- `preferred_trigger` is honoured on the **first bind only**. An app can't change its own shortcut
  afterward — only `ConfigureShortcuts` (the desktop's own editor) can add/remove triggers, and
  it's additive: user-added triggers keep firing even after the app's default is unchecked.
- Always best to pass a `preferred_trigger`. Leaving it unset (tested on KDE Plasma 6) still lets the user pick a key combo in the consent dialog, but that dialog is easy to miss the point of — safer to ship a sensible default the user can change later via `ConfigureShortcuts` than to leave first-run UX up to how well they read the dialog. A knowledgable user can always override the default in that dialog anyway.
- There's no unbind. A full reset requires the user to delete the whole app entry in their desktop's
  shortcut settings.
- Dispatch on the `shortcut_id` carried by the `Activated` signal — never a locally reconstructed
  id (this is what breaks Electron's own portal path, which derives ids from the accelerator
  string instead).
- There's no automatic reconnect on an unexpected D-Bus disconnect (bus crash, compositor restart,
  suspend/resume). `onDisconnected` fires so the app can call `start()` again; a transparent
  socket-level reconnect wouldn't help since a fresh `Session` and rebind are required regardless.

## Files

- `electron/dbusWire.cjs` — D-Bus wire protocol: signatures, marshalling, message framing.
- `electron/dbusConnection.cjs` — generic bus client: connect, SASL auth, call/signal dispatch.
- `electron/portalShortcuts.cjs` — the GlobalShortcuts module (the actual deliverable).
- `scripts/portal-client-probe.cjs` — standalone CLI for manual testing.
- `portal-shortcut-probe.py` — the original Python reference implementation.

## Module API

```js
const portal = require('./electron/portalShortcuts.cjs');
portal.init(log); // log(level, message)

const result = await portal.start({
  id: 'toggle-recording',
  description: 'Start or stop dictation',
  preferredTrigger: 'CTRL+ALT+space', // XDG syntax, honored on first bind only
  onActivated: () => { /* toggle recording */ },
  onDisconnected: () => { /* the D-Bus connection dropped unexpectedly; call start() again to recover */ },
});
// -> { ok: true, triggerDescription } | { ok: false, reason: 'unavailable'|'denied'|'error', error? }

portal.isAvailable();
await portal.configure(); // opens the desktop's shortcut editor
portal.stop();
```

## Example CLI

```
node scripts/portal-client-probe.cjs bind [TRIGGER]     # create, bind, wait for presses
node scripts/portal-client-probe.cjs listen             # create, list only (no bind)
node scripts/portal-client-probe.cjs rebind [TRIGGER]   # create, bind same id again, wait
node scripts/portal-client-probe.cjs configure          # bind, then open the desktop's editor
```

## Tests

```
pnpm install
pnpm test
```
