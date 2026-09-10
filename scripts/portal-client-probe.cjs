#!/usr/bin/env node
// Standalone CLI harness for electron/portalShortcuts.cjs -- mirrors portal-shortcut-probe.py so
// the two can be run side by side on the same machine and compared per the acceptance table in
// portal-client-spec.md section 7.
//
// Usage:
//   node scripts/portal-client-probe.cjs bind [TRIGGER]     # create, bind, wait for presses
//   node scripts/portal-client-probe.cjs listen             # create, list only, wait
//   node scripts/portal-client-probe.cjs rebind [TRIGGER]   # create, bind same id again, wait
//   node scripts/portal-client-probe.cjs configure          # bind, then open the desktop's editor

'use strict';

const path = require('path');
const { DBusConnection } = require(path.join(__dirname, '..', 'electron', 'dbusConnection.cjs'));
const portalShortcuts = require(path.join(__dirname, '..', 'electron', 'portalShortcuts.cjs'));

const {
  createSession, bindShortcuts, listShortcuts, configureShortcuts, checkAvailable,
  PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE,
} = portalShortcuts._internal;

const DEFAULT_TRIGGER = 'CTRL+ALT+j';
// Deliberately distinct from the Python probe's "probe-toggle" id, so the two don't fight over
// the same binding when run side by side; one stable id per app, per landmine #9/#7.
const SHORTCUT_ID = 'jsclient-toggle';

function reportShortcuts(shortcuts, label) {
  if (!shortcuts || shortcuts.length === 0) {
    console.log(`NO shortcuts ${label} -- the portal returned an empty list`);
    return;
  }
  console.log(`shortcuts ${label}:`);
  for (const [sid, props] of shortcuts) {
    console.log(`  id=${JSON.stringify(sid)}  trigger=${JSON.stringify(props.trigger_description || '(no trigger reported)')}`);
  }
}

function cliLog(level, msg) {
  console.log(`[${level}] ${msg}`);
}

async function runCli(argv) {
  const mode = argv[2];
  const validModes = ['bind', 'listen', 'rebind', 'configure'];
  if (!validModes.includes(mode)) {
    console.error(`Usage: node ${path.basename(__filename)} <${validModes.join('|')}> [TRIGGER]`);
    process.exitCode = 1;
    return;
  }
  const trigger = argv[3] || DEFAULT_TRIGGER;

  const c = new DBusConnection(cliLog);
  try {
    await c.connect();
  } catch (err) {
    console.error(`FAIL: no D-Bus session bus available: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  process.on('SIGINT', () => {
    console.log('\ndone');
    c.close();
    process.exit(0);
  });

  await c.hello();
  await c.addMatch(`type='signal',sender='${PORTAL_NAME}'`);

  const avail = await checkAvailable(c);
  if (!avail.available) {
    console.error(
      'FAIL: no GlobalShortcuts portal on this session.\n'
      + `       (${avail.error})\n`
      + '       Implemented by xdg-desktop-portal-kde, -gnome and -hyprland; NOT by\n'
      + '       -wlr (sway) or -gtk (the X11 fallback).',
    );
    c.close();
    process.exitCode = 1;
    return;
  }
  console.log(`GlobalShortcuts portal present, interface version ${avail.version}`);

  c.onSignal({ path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'Activated' }, (msg) => {
    console.log(`  >>> Activated: id=${JSON.stringify(msg.body[1])} session=${msg.body[0]}`);
  });
  c.onSignal({ path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'Deactivated' }, (msg) => {
    console.log(`  >>> Deactivated: id=${JSON.stringify(msg.body[1])} session=${msg.body[0]}`);
  });

  const sessionResult = await createSession(c);
  if (sessionResult.code !== 0) {
    console.error(`FAIL: CreateSession returned response code ${sessionResult.code} (1 = cancelled by user)`);
    process.exitCode = 1;
    c.close();
    return;
  }
  const sess = sessionResult.sessionHandle;
  console.log(`session: ${sess}`);

  if (mode === 'configure' || mode === 'bind' || mode === 'rebind') {
    // NOTE: rebind is NOT expected to allow re-assigning the shortcut: the user is responsible for doing that himself.
    // The id can only be set once (with a single, default, unchanging shortcut); only the user can remove this default.
    // A "change" means the user disabling the default shortcut key and adding an enabled alternative.
    if (mode === 'rebind') console.log('(re-binding the same id on a new session -- note whether a prompt appears)');
    console.log(`requesting preferred_trigger=${JSON.stringify(trigger)} for id=${JSON.stringify(SHORTCUT_ID)}`);
    const bindResult = await bindShortcuts(c, sess, [{ id: SHORTCUT_ID, description: 'JS shortcut probe: toggle recording', preferredTrigger: trigger }]);
    if (bindResult.code !== 0) {
      console.error(`FAIL: BindShortcuts returned response code ${bindResult.code} (1 = cancelled by user)`);
      process.exitCode = 1;
      c.close();
      return;
    }
    reportShortcuts(bindResult.shortcuts, 'bound');
    const got = bindResult.shortcuts.find(([sid]) => sid === SHORTCUT_ID);
    const gotTrigger = got ? got[1].trigger_description : undefined;
    if (gotTrigger && trigger.toLowerCase().replace(/\+/g, '') !== gotTrigger.toLowerCase().replace(/\+/g, '')) {
      console.log(`NOTE: asked for ${JSON.stringify(trigger)} but the portal reports ${JSON.stringify(gotTrigger)} -- the existing trigger won`);
    }
    if (mode === 'configure') {
      await configureShortcuts(c, sess);
      console.log("ConfigureShortcuts called -- the desktop's shortcut editor should be on screen now.");
      console.log('Change the key there, then watch whether presses below use the NEW key.');
    }
  } else {
    // listen: ListShortcuts only, no bind -- tests whether restoring a session re-arms anything.
    const listResult = await listShortcuts(c, sess);
    if (listResult.code !== 0) {
      console.error(`FAIL: ListShortcuts returned response code ${listResult.code}`);
      process.exitCode = 1;
      c.close();
      return;
    }
    reportShortcuts(listResult.shortcuts, 'restored from a previous run');
  }

  console.log();
  console.log(`Now press the shortcut (${trigger}, or whatever the desktop actually assigned).`);
  console.log('Every press should print a line below. Ctrl+C when done.');
  console.log("If nothing prints, note whether the keystroke reaches the terminal: if it does,");
  console.log('the compositor never grabbed the key.');

  await new Promise(() => {}); // wait for Ctrl+C
}

runCli(process.argv).catch((err) => {
  console.error(`FAIL: ${err.stack || err.message}`);
  process.exitCode = 1;
});
