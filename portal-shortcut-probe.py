#!/usr/bin/env python3
"""Probe the XDG GlobalShortcuts portal directly, independently of any app or toolkit.

Drives CreateSession / BindShortcuts / ListShortcuts / ConfigureShortcuts over one D-Bus
connection, using a single fixed shortcut id and taking ids only from what the portal returns.

Why Python/Gio rather than a shell script: a portal session lives and dies with the D-Bus
CONNECTION, so `gdbus call` cannot be used -- each invocation is its own short-lived connection and
the session would be destroyed the moment the call returned. This needs one connection held open
across create -> bind -> wait.

Requires python3-gobject  (Fedora: sudo dnf install python3-gobject)

Usage:
    ./portal-shortcut-probe.py bind     # create a session, bind, wait for presses
    ./portal-shortcut-probe.py listen   # create a session, list only, wait for presses
    ./portal-shortcut-probe.py rebind   # create a session, bind the SAME id again, wait

    ./portal-shortcut-probe.py rebind CTRL+ALT+k    # same id, DIFFERENT key
    ./portal-shortcut-probe.py configure            # bind, then open the desktop's editor

MEASURED, Fedora KDE Plasma 6 / Wayland, 2026-09:

    bind                    armed, delivers
    listen                  shortcut LISTED but NOT armed -- the key still reaches the focused
                            window, so restoring a session does not re-arm anything
    rebind (same key)       armed, delivers, no prompt
    rebind (different key)  the OLD trigger wins: the new key is never captured, the old one still
                            fires, and NO second binding is created
    configure               opens System Settings on our app. "Add+" captures ADDITIONAL keys for
                            the same shortcut, and each trigger has its own checkbox: unchecking the
                            app-supplied default leaves user-added keys active and firing. Triggers
                            can be disabled but not deleted (only the whole app entry can be
                            removed). Since Activated carries the shortcut id, every trigger reaches
                            the same handler.

Consequences for any app using this portal: call BindShortcuts on every launch (ListShortcuts alone
does not re-arm); use one stable shortcut id for the app's lifetime (one id yields exactly one
binding, ever); preferred_trigger is honoured on the FIRST bind only -- an app cannot change its own
shortcut afterward, only the user can, via ConfigureShortcuts or their desktop's settings; there is
no unbind, only removing the whole app entry.
"""

import sys
import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SHORTCUTS_IFACE = "org.freedesktop.portal.GlobalShortcuts"
REQUEST_IFACE = "org.freedesktop.portal.Request"

# A single stable id: one id yields exactly one binding, ever (see MEASURED above).
SHORTCUT_ID = "probe-toggle"
# Portal syntax, not a UI toolkit's; see the XDG shortcuts spec. Overridable on the command line so
# the same id can be re-bound with a DIFFERENT key -- see `rebind` above.
DEFAULT_TRIGGER = "CTRL+ALT+j"
trigger = DEFAULT_TRIGGER

_token_counter = 0


def next_token(prefix):
    global _token_counter
    _token_counter += 1
    return f"probe{prefix}{_token_counter}"


def sender_token(conn):
    """Our unique bus name in the form the portal uses to build Request object paths."""
    return conn.get_unique_name()[1:].replace(".", "_")


def call_with_response(conn, loop, method, params_builder, timeout_s=120):
    """Invoke a portal method and return the results from its Request::Response signal.

    The Response subscription must exist BEFORE the method call, or a fast portal can answer
    before we are listening. The request path is predictable from our sender name and token,
    which is exactly why the portal defines handle_token.
    """
    token = next_token(method.lower())
    request_path = f"{PORTAL_PATH}/request/{sender_token(conn)}/{token}"

    result = {}

    def on_response(_conn, _sender, _path, _iface, _signal, parameters):
        code, results = parameters.unpack()
        result["code"] = code
        result["results"] = results
        loop.quit()

    sub = conn.signal_subscribe(
        PORTAL_NAME, REQUEST_IFACE, "Response", request_path, None,
        Gio.DBusSignalFlags.NONE, on_response,
    )

    conn.call_sync(
        PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE, method,
        params_builder(token), None, Gio.DBusCallFlags.NONE, -1, None,
    )

    # The portal may show a dialog here (KDE asks for consent; GNOME always does), so this waits
    # on the user, not just on IPC.
    GLib.timeout_add_seconds(timeout_s, lambda: (loop.quit(), False)[1])
    loop.run()

    if "code" not in result:
        sys.exit(f"FAIL: no Response to {method} within {timeout_s}s")
    conn.signal_unsubscribe(sub)
    if result["code"] != 0:
        # 1 = user cancelled, 2 = ended some other way
        sys.exit(f"FAIL: {method} returned response code {result['code']} (1 = cancelled by user)")
    return result["results"]


def check_available(conn):
    try:
        version = conn.call_sync(
            PORTAL_NAME, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", (SHORTCUTS_IFACE, "version")),
            None, Gio.DBusCallFlags.NONE, 5000, None,
        ).unpack()[0]
        print(f"GlobalShortcuts portal present, interface version {version}")
    except GLib.Error as e:
        sys.exit(
            "FAIL: no GlobalShortcuts portal on this session.\n"
            f"       ({e.message})\n"
            "       Implemented by xdg-desktop-portal-kde, -gnome and -hyprland; NOT by\n"
            "       -wlr (sway) or -gtk (the X11 fallback)."
        )


def create_session(conn, loop):
    def build(token):
        return GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", token),
            "session_handle_token": GLib.Variant("s", next_token("sess")),
        },))

    results = call_with_response(conn, loop, "CreateSession", build)
    handle = results["session_handle"]
    print(f"session: {handle}")
    return handle


def bind(conn, loop, session):
    def build(token):
        shortcuts = [(SHORTCUT_ID, {
            "description": GLib.Variant("s", "Python shortcut probe: toggle recording"),
            "preferred_trigger": GLib.Variant("s", trigger),
        })]
        return GLib.Variant("(oa(sa{sv})sa{sv})", (
            session, shortcuts, "", {"handle_token": GLib.Variant("s", token)},
        ))

    print(f"requesting preferred_trigger={trigger!r} for id={SHORTCUT_ID!r}")
    results = call_with_response(conn, loop, "BindShortcuts", build)
    report(results.get("shortcuts", []), "bound")
    # The portal treats preferred_trigger as a *suggestion*. If what comes back differs from what
    # we asked for, the desktop kept the trigger it already had -- which means an app cannot change
    # its own shortcut, and the user has to do it in their desktop settings.
    got = [props.get("trigger_description") for _, props in results.get("shortcuts", [])]
    if got and trigger.lower().replace("+", "") not in (got[0] or "").lower().replace("+", ""):
        print(f"NOTE: asked for {trigger!r} but the portal reports {got[0]!r} -- "
              "the existing trigger won")


def configure_shortcuts(conn, session):
    """Ask the desktop to show its own editor for this session's shortcuts.

    Unlike the others this is a plain method call, not a Request: the interface declares no OUT
    parameter and emits no Response, so there is nothing to await -- the UI either appears or it
    doesn't. This is the only sanctioned way for an app to let the user change a shortcut, because
    preferred_trigger is honoured on the first bind only.
    """
    conn.call_sync(
        PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE, "ConfigureShortcuts",
        GLib.Variant("(osa{sv})", (session, "", {})),
        None, Gio.DBusCallFlags.NONE, 5000, None,
    )
    print("ConfigureShortcuts called -- the desktop's shortcut editor should be on screen now.")
    print("Change the key there, then watch whether presses below use the NEW key.")


def list_shortcuts(conn, loop, session):
    def build(token):
        return GLib.Variant("(oa{sv})", (session, {"handle_token": GLib.Variant("s", token)}))

    results = call_with_response(conn, loop, "ListShortcuts", build)
    report(results.get("shortcuts", []), "restored from a previous run")


def report(shortcuts, label):
    if not shortcuts:
        print(f"NO shortcuts {label} -- the portal returned an empty list")
        return
    print(f"shortcuts {label}:")
    for sid, props in shortcuts:
        trigger = props.get("trigger_description", "(no trigger reported)")
        print(f"  id={sid!r}  trigger={trigger!r}")


def wait_for_presses(conn, loop):
    def on_activated(_c, _s, _p, _i, signal, parameters):
        unpacked = parameters.unpack()
        session, shortcut_id = unpacked[0], unpacked[1]
        print(f"  >>> {signal}: id={shortcut_id!r} session={session}")

    for sig in ("Activated", "Deactivated"):
        conn.signal_subscribe(
            PORTAL_NAME, SHORTCUTS_IFACE, sig, PORTAL_PATH, None,
            Gio.DBusSignalFlags.NONE, on_activated,
        )

    print()
    print(f"Now press the shortcut ({trigger}, or whatever the desktop actually assigned).")
    print("If you just re-bound with a NEW key, try the OLD one too: if both fire, the desktop")
    print("kept two bindings, which is the accumulation problem.")
    print("Every press should print a line below. Ctrl+C when done.")
    print("If nothing prints, note whether the keystroke reaches the terminal (a stray ^[ or a")
    print("newline): if it does, the compositor never grabbed the key, which is a different")
    print("failure from grabbing it and not delivering the signal.")
    loop.run()


def main():
    global trigger
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("bind", "listen", "rebind", "configure"):
        sys.exit(__doc__)
    if len(sys.argv) > 2:
        trigger = sys.argv[2]

    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    check_available(conn)

    session = create_session(conn, loop)
    if mode == "configure":
        # Bind first: the editor shows the shortcuts *of this session*, so a session that has not
        # bound anything has nothing to configure.
        bind(conn, loop, session)
        configure_shortcuts(conn, session)
    elif mode in ("bind", "rebind"):
        # Same call either way: the point of "rebind" is that a later run asks for the identical
        # shortcut id on a fresh session, which is what an app does on every restart. Watch whether
        # it prompts again, and whether presses arrive afterwards.
        if mode == "rebind":
            print("(re-binding the same id on a new session -- note whether a prompt appears)")
        bind(conn, loop, session)
    else:
        # Per the spec, ListShortcuts on a session that has not called BindShortcuts "returns the
        # shortcuts that were successfully bound in a previous session by this application" -- so
        # this is the restoration path, with no re-binding and no prompt. On Plasma 6 this reports
        # the shortcut but leaves it unarmed: the key still reaches the focused window.
        list_shortcuts(conn, loop, session)

    try:
        wait_for_presses(conn, loop)
    except KeyboardInterrupt:
        print("\ndone")


if __name__ == "__main__":
    main()
