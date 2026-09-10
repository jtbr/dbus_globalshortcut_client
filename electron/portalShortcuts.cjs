// Dependency-free D-Bus client for the XDG GlobalShortcuts portal.
//
// Reimplements scripts/portal-shortcut-probe.py in JavaScript so Unhush can bind its own global
// hotkey on KDE, GNOME and Hyprland Wayland sessions without Electron's broken portal path (see
// portal-client-spec.md for the full background). No npm dependencies -- Node built-ins only.
//
// Module API:
//   const portal = require("./portalShortcuts.cjs");
//   portal.init(log);
//   const result = await portal.start({ id, description, preferredTrigger, onActivated });
//   portal.isAvailable();
//   await portal.configure();
//   portal.stop();
//
// Also runnable as a standalone CLI harness -- see runCli() below and the usage string.

'use strict';

const net = require('net');
const {
  variant, dictToObject, MESSAGE_TYPE, buildMessage, tryParseMessage,
} = require('./dbusWire.cjs');

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const BUS_IFACE = 'org.freedesktop.DBus';

const REQUEST_TIMEOUT_MS = 120000; // the consent dialog is a human in the loop; bound every wait

class DBusError extends Error {
  constructor(errorName, detail) {
    super(`${errorName}${detail ? `: ${detail}` : ''}`);
    this.name = 'DBusError';
    this.errorName = errorName;
  }
}

function parseBusAddress(addr) {
  // e.g. "unix:path=/run/user/1000/bus" or "unix:abstract=/tmp/dbus-XXXX,guid=..."; may list
  // several ";"-separated addresses to try -- we only need the first that parses.
  const first = addr.split(';')[0];
  if (!first.startsWith('unix:')) throw new Error(`unsupported D-Bus address (only unix: is supported): ${addr}`);
  const kv = {};
  for (const pair of first.slice('unix:'.length).split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    kv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (kv.path) return kv.path;
  // Node connects to an abstract socket via a path whose first byte is NUL.
  if (kv.abstract) return `\0${kv.abstract}`;
  throw new Error(`unix D-Bus address missing path= or abstract=: ${addr}`);
}

class DBusConnection {
  constructor(log) {
    this.log = log || (() => {});
    this.socket = null;
    this.serial = 1;
    this.pending = new Map();
    this.signalHandlers = [];
    this.recvBuf = Buffer.alloc(0);
    this.uniqueName = null;
  }

  async connect() {
    const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!addr) throw new Error('DBUS_SESSION_BUS_ADDRESS is not set');
    const path = parseBusAddress(addr);

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      const onError = (err) => reject(err);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        resolve();
      });
    });

    this.socket.on('error', (err) => this._onSocketError(err));
    this.socket.on('close', () => this._onSocketClose());

    await this._handshake();
  }

  async _handshake() {
    // SASL EXTERNAL: prove our uid, then switch to binary D-Bus framing. See spec 4.2.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const hex = Buffer.from(String(uid), 'ascii').toString('hex');

    const { line, rest } = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n');
        if (idx !== -1) {
          this.socket.removeListener('data', onData);
          this.socket.removeListener('error', onError);
          resolve({ line: buf.subarray(0, idx).toString('ascii'), rest: buf.subarray(idx + 2) });
        }
      };
      const onError = (err) => reject(err);
      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.write(Buffer.from([0]));
      this.socket.write(`AUTH EXTERNAL ${hex}\r\n`);
    });

    if (!line.startsWith('OK ')) throw new Error(`D-Bus SASL auth rejected: ${line}`);
    this.socket.write('BEGIN\r\n');

    this.recvBuf = rest;
    this.socket.on('data', (chunk) => this._onData(chunk));
    if (this.recvBuf.length) this._onData(Buffer.alloc(0));
  }

  _onData(chunk) {
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;
    for (;;) {
      let parsed;
      try {
        parsed = tryParseMessage(this.recvBuf);
      } catch (err) {
        this.log('error', `dbus: failed to parse incoming message, dropping buffer: ${err.message}`);
        this.recvBuf = Buffer.alloc(0);
        return;
      }
      if (!parsed) return;
      this.recvBuf = this.recvBuf.subarray(parsed.consumed);
      this._dispatch(parsed.message);
    }
  }

  _dispatch(msg) {
    if (msg.type === MESSAGE_TYPE.METHOD_RETURN || msg.type === MESSAGE_TYPE.ERROR) {
      const p = this.pending.get(msg.replySerial);
      if (!p) return;
      this.pending.delete(msg.replySerial);
      if (msg.type === MESSAGE_TYPE.ERROR) {
        p.reject(new DBusError(msg.errorName, msg.body && msg.body[0]));
      } else {
        p.resolve(msg.body);
      }
      return;
    }
    if (msg.type === MESSAGE_TYPE.SIGNAL) {
      for (const h of this.signalHandlers.slice()) {
        if (h.path && h.path !== msg.path) continue;
        if (h.iface && h.iface !== msg.iface) continue;
        if (h.member && h.member !== msg.member) continue;
        try {
          h.fn(msg);
        } catch (err) {
          this.log('error', `dbus: signal handler for ${msg.iface}.${msg.member} threw: ${err.message}`);
        }
      }
    }
  }

  _onSocketError(err) {
    this.log('error', `dbus: socket error: ${err.message}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  _onSocketClose() {
    const err = new Error('D-Bus connection closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  call({ destination, path, iface, member, bodySig = '', bodyValues = [] }) {
    const serial = this.serial++;
    const msg = buildMessage({
      type: MESSAGE_TYPE.METHOD_CALL, flags: 0, serial, path, iface, member, destination, bodySig, bodyValues,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.socket.write(msg);
    });
  }

  // Rule string, e.g. "type='signal',sender='org.freedesktop.portal.Desktop'".
  onSignal({ path, iface, member }, fn) {
    const entry = { path, iface, member, fn };
    this.signalHandlers.push(entry);
    return () => {
      const i = this.signalHandlers.indexOf(entry);
      if (i !== -1) this.signalHandlers.splice(i, 1);
    };
  }

  async hello() {
    const [name] = await this.call({ destination: BUS_NAME, path: BUS_PATH, iface: BUS_IFACE, member: 'Hello' });
    this.uniqueName = name;
    return name;
  }

  addMatch(rule) {
    return this.call({
      destination: BUS_NAME, path: BUS_PATH, iface: BUS_IFACE, member: 'AddMatch', bodySig: 's', bodyValues: [rule],
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

let tokenCounter = 0;
function nextToken(prefix) {
  tokenCounter += 1;
  return `${prefix}${tokenCounter}`; // must stay [A-Za-z0-9_] -- a valid object-path element
}

function senderToken(uniqueName) {
  return uniqueName.slice(1).replace(/\./g, '_'); // ":1.234" -> "1_234"
}

// Drives the Request pattern (spec 5.1): subscribe to Request::Response at the predictable path
// *before* issuing the call, since a fast portal can answer before we'd otherwise be listening.
function callWithResponse(conn, method, buildBody, timeoutMs = REQUEST_TIMEOUT_MS) {
  const token = nextToken('t');
  const requestPath = `${PORTAL_PATH}/request/${senderToken(conn.uniqueName)}/${token}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new Error(`timeout waiting for ${method} response after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = conn.onSignal({ path: requestPath, iface: REQUEST_IFACE, member: 'Response' }, (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      const [code, resultsPairs] = msg.body;
      resolve({ code, results: dictToObject(resultsPairs) });
    });

    const { sig, values } = buildBody(token);
    conn.call({
      destination: PORTAL_NAME, path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: method, bodySig: sig, bodyValues: values,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      reject(err);
    });
  });
}

async function checkAvailable(conn) {
  try {
    const [v] = await conn.call({
      destination: PORTAL_NAME, path: PORTAL_PATH, iface: 'org.freedesktop.DBus.Properties', member: 'Get', bodySig: 'ss', bodyValues: [SHORTCUTS_IFACE, 'version'],
    });
    return { available: true, version: v.value };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

async function createSession(conn) {
  const { code, results } = await callWithResponse(conn, 'CreateSession', (token) => ({
    sig: 'a{sv}',
    values: [[
      ['handle_token', variant('s', token)],
      ['session_handle_token', variant('s', nextToken('sess'))],
    ]],
  }));
  if (code !== 0) return { code };
  // session_handle comes back typed as STRING, a documented quirk -- BindShortcuts etc. take it
  // as an object path ('o'), but the wire encoding is identical so no conversion is needed.
  return { code, sessionHandle: results.session_handle };
}

// Unwraps the nested a{sv} inside each (id, props) pair that BindShortcuts/ListShortcuts return.
function unwrapShortcuts(rawShortcuts) {
  return (rawShortcuts || []).map(([id, innerPairs]) => [id, dictToObject(innerPairs)]);
}

async function bindShortcuts(conn, session, shortcuts, parentWindow = '') {
  const { code, results } = await callWithResponse(conn, 'BindShortcuts', (token) => {
    const shortcutsValue = shortcuts.map((sc) => {
      const props = [['description', variant('s', sc.description)]];
      if (sc.preferredTrigger) props.push(['preferred_trigger', variant('s', sc.preferredTrigger)]);
      return [sc.id, props];
    });
    return {
      sig: 'oa(sa{sv})sa{sv}',
      values: [session, shortcutsValue, parentWindow, [['handle_token', variant('s', token)]]],
    };
  });
  if (code !== 0) return { code };
  return { code, shortcuts: unwrapShortcuts(results.shortcuts) };
}

async function listShortcuts(conn, session) {
  const { code, results } = await callWithResponse(conn, 'ListShortcuts', (token) => ({
    sig: 'oa{sv}',
    values: [session, [['handle_token', variant('s', token)]]],
  }));
  if (code !== 0) return { code };
  return { code, shortcuts: unwrapShortcuts(results.shortcuts) };
}

// Plain method call: no OUT parameter, no Response signal -- the editor appears or it doesn't.
async function configureShortcuts(conn, session, parentWindow = '') {
  await conn.call({
    destination: PORTAL_NAME, path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'ConfigureShortcuts', bodySig: 'osa{sv}', bodyValues: [session, parentWindow, []],
  });
}

// --- Module API (electron/*.cjs sibling shape: init(log), then instance methods) --------------

let log = () => {};
let conn = null;
let session = null;
let boundId = null;
let available = false;

function init(logger) {
  log = logger || (() => {});
}

async function start({ id, description, preferredTrigger, onActivated, parentWindow = '' }) {
  if (conn) {
    log('warn', 'portal: start() called while already started; call stop() first');
    return { ok: false, reason: 'error', error: 'already started' };
  }

  let c;
  try {
    c = new DBusConnection(log);
    await c.connect();
  } catch (err) {
    log('info', `portal: unavailable (no D-Bus session bus): ${err.message}`);
    return { ok: false, reason: 'unavailable', error: err.message };
  }

  try {
    await c.hello();
    await c.addMatch(`type='signal',sender='${PORTAL_NAME}'`);

    const avail = await checkAvailable(c);
    if (!avail.available) {
      log('info', `portal: unavailable (no GlobalShortcuts backend): ${avail.error}`);
      c.close();
      return { ok: false, reason: 'unavailable', error: avail.error };
    }
    log('info', `portal: GlobalShortcuts version ${avail.version}`);

    c.onSignal({ path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'Activated' }, (msg) => {
      const shortcutId = msg.body[1];
      // Dispatch on the id the portal sent -- never a locally reconstructed one (this is the
      // exact Chromium bug this module exists to avoid).
      if (shortcutId === id) {
        log('info', `portal: Activated ${shortcutId}`);
        try {
          if (onActivated) onActivated();
        } catch (err) {
          log('error', `portal: onActivated handler threw: ${err.message}`);
        }
      }
    });

    const sessionResult = await createSession(c);
    if (sessionResult.code !== 0) {
      c.close();
      return { ok: false, reason: sessionResult.code === 1 ? 'denied' : 'error', error: `CreateSession response code ${sessionResult.code}` };
    }

    const bindResult = await bindShortcuts(c, sessionResult.sessionHandle, [{ id, description, preferredTrigger }], parentWindow);
    if (bindResult.code === 1) {
      c.close();
      return { ok: false, reason: 'denied' };
    }
    if (bindResult.code !== 0) {
      c.close();
      return { ok: false, reason: 'error', error: `BindShortcuts response code ${bindResult.code}` };
    }

    conn = c;
    session = sessionResult.sessionHandle;
    boundId = id;
    available = true;

    const bound = bindResult.shortcuts.find(([sid]) => sid === id);
    const triggerDescription = bound ? bound[1].trigger_description : undefined;
    if (!triggerDescription) {
      log('warn', `portal: shortcut ${id} is bound but every trigger is disabled -- it will not fire`);
    }
    return { ok: true, triggerDescription, shortcuts: bindResult.shortcuts };
  } catch (err) {
    log('error', `portal: start() failed: ${err.message}`);
    c.close();
    return { ok: false, reason: 'error', error: err.message };
  }
}

function isAvailable() {
  return available;
}

async function configure() {
  if (!conn || !session) {
    log('warn', 'portal: configure() called before a successful start()');
    return { ok: false, reason: 'error', error: 'not started' };
  }
  try {
    await configureShortcuts(conn, session);
    return { ok: true };
  } catch (err) {
    log('error', `portal: configure() failed: ${err.message}`);
    return { ok: false, reason: 'error', error: err.message };
  }
}

function stop() {
  if (conn) conn.close();
  conn = null;
  session = null;
  boundId = null;
  available = false;
}

module.exports = {
  init, start, isAvailable, configure, stop,
  // Exposed for the CLI harness below and for tests; not part of the documented module API.
  _internal: {
    DBusConnection, createSession, bindShortcuts, listShortcuts, configureShortcuts, checkAvailable,
    PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE,
  },
};

// --- CLI harness -------------------------------------------------------------------------------
//
// Mirrors scripts/portal-shortcut-probe.py so the two can be run side by side on the same
// machine and compared per the acceptance table in spec section 7.

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
    console.error(`Usage: node portalShortcuts.cjs <${validModes.join('|')}> [TRIGGER]`);
    process.exitCode = 1;
    return;
  }
  const trigger = argv[3] || DEFAULT_TRIGGER;

  const { DBusConnection: Conn, createSession: create, bindShortcuts: bind, listShortcuts: list, configureShortcuts: cfg, checkAvailable: check } = module.exports._internal;

  const c = new Conn(cliLog);
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

  const avail = await check(c);
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

  const sessionResult = await create(c);
  if (sessionResult.code !== 0) {
    console.error(`FAIL: CreateSession returned response code ${sessionResult.code} (1 = cancelled by user)`);
    process.exitCode = 1;
    c.close();
    return;
  }
  const sess = sessionResult.sessionHandle;
  console.log(`session: ${sess}`);

  if (mode === 'configure' || mode === 'bind' || mode === 'rebind') {
    if (mode === 'rebind') console.log('(re-binding the same id on a new session -- note whether a prompt appears)');
    console.log(`requesting preferred_trigger=${JSON.stringify(trigger)} for id=${JSON.stringify(SHORTCUT_ID)}`);
    const bindResult = await bind(c, sess, [{ id: SHORTCUT_ID, description: 'Unhush JS probe: toggle recording', preferredTrigger: trigger }]);
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
      await cfg(c, sess);
      console.log("ConfigureShortcuts called -- the desktop's shortcut editor should be on screen now.");
      console.log('Change the key there, then watch whether presses below use the NEW key.');
    }
  } else {
    // listen: ListShortcuts only, no bind -- tests whether restoring a session re-arms anything.
    const listResult = await list(c, sess);
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

if (require.main === module) {
  runCli(process.argv).catch((err) => {
    console.error(`FAIL: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
