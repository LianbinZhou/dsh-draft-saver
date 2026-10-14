/**
 * Drives the real browser half against a fake localStorage.
 *
 * The guard is a storage-level wrapper, so the test feeds it exactly what the
 * Harness feeds the browser: whole-value JSON written to
 * `dsh.conversation.<sessionId>` by the conversation store, and read back when
 * a Session mounts its composer.
 *
 * No browser, no React, no dependencies: a fake module loader captures the
 * client factory and stub hooks record what the plugin registers.
 *
 *   node test/draft.test.mjs
 */
const CLIENT = new URL('../client.js', import.meta.url);

/* ------------------------------------------------------------------ *
 * minimal assert                                                      *
 * ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  ok   ' + label);
    return;
  }
  failures += 1;
  console.log('  FAIL ' + label + '\n         expected ' + e + '\n         actual   ' + a);
}

function ok(label, condition) {
  check(label, Boolean(condition), true);
}

/* ------------------------------------------------------------------ *
 * fake localStorage                                                   *
 * ------------------------------------------------------------------ */

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key) {
    const name = String(key);
    return this.map.has(name) ? this.map.get(name) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
  }
  clear() {
    this.map.clear();
  }
}

const storage = new FakeStorage();
globalThis.localStorage = storage;

/* ------------------------------------------------------------------ *
 * stub React: the notice component is captured, never rendered         *
 * ------------------------------------------------------------------ */

const React = {
  createElement: () => null,
  useEffect: () => {},
  useState: (value) => [value, () => {}],
};

/* ------------------------------------------------------------------ *
 * load the real client half                                           *
 * ------------------------------------------------------------------ */

let definition = null;
globalThis.window = { __ModuleLoader__: { load(def) { definition = def; } } };
await import(CLIENT.href);
if (!definition) throw new Error('client.js never called __ModuleLoader__.load');
check('module id', definition.id, 'dsh-draft-saver');

const plugin = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

const disposers = [];
const registered = [];
plugin.apply({
  effect: (fn) => {
    const disposer = fn();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  locale: { register: () => () => {}, bind: () => (key, params) => key + (params ? ' ' + JSON.stringify(params) : '') },
  slots: {
    inject: (_slot, fn) => fn(),
    register: (options, Component) => {
      registered.push({ options, Component });
      return () => {};
    },
  },
});

check('registered slots', registered.map((r) => r.options.id), ['draft-saver.notice']);

/* ------------------------------------------------------------------ *
 * helpers mirroring what the conversation store writes                *
 * ------------------------------------------------------------------ */

const BACKUP = 'dsh-draft-saver.backup.v1';
const key = (id) => 'dsh.conversation.' + id;

/** The conversation store persists the whole state object as JSON. */
const stateWith = (text) => JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null });

function backup() {
  const raw = storage.getItem(BACKUP);
  return raw === null ? null : JSON.parse(raw);
}

/* ------------------------------------------------------------------ *
 * 1. a non-empty draft write is mirrored                              *
 * ------------------------------------------------------------------ */

console.log('\ndraft mirroring');
storage.setItem(key('session-A'), stateWith('第一段草稿'));
ok('backup written for the new draft', backup() !== null);
check('backup remembers its source session', backup().key, key('session-A'));
check('backup counts characters', backup().chars, 5);
check('backup keeps the original value verbatim', backup().raw, stateWith('第一段草稿'));

storage.setItem(key('session-A'), stateWith('第一段草稿，又补了几个字'));
ok('a later edit replaces the backup', backup().chars > 5);

storage.setItem(key('session-A'), JSON.stringify({ draft: '', view: null, viewRequest: null }));
check('emptying the source session spends the backup', backup(), null);

/* ------------------------------------------------------------------ *
 * 2. a brand-new session inherits the unsent draft                    *
 * ------------------------------------------------------------------ */

console.log('\nrestoring into a new session');
storage.setItem(key('session-A'), stateWith('要发给模型的半句话'));
storage.setItem('dsh.conversation-view.state', 'untouched');

const restored = storage.getItem(key('session-B'));
check('a new session reads the backup instead of nothing', restored, stateWith('要发给模型的半句话'));
ok('a non-draft key is untouched', storage.getItem('dsh.conversation-view.state') === 'untouched');

const own = storage.getItem(key('session-A'));
check('the owning session still reads its own draft', own, stateWith('要发给模型的半句话'));

/* ------------------------------------------------------------------ *
 * 3. once the new session is used, the backup follows it              *
 * ------------------------------------------------------------------ */

console.log('\nconsuming the backup');
storage.setItem(key('session-B'), stateWith('要发给模型的半句话'));
check('the backup now belongs to the session that received it', backup().key, key('session-B'));

storage.setItem(key('session-B'), JSON.stringify({ draft: { text: '', references: [] }, view: null, viewRequest: null }));
check('sending or clearing it drops the backup', backup(), null);
check('and nothing is injected afterwards', storage.getItem(key('session-C')), null);

/* ------------------------------------------------------------------ *
 * 4. legacy string drafts, and empty writes                           *
 * ------------------------------------------------------------------ */

console.log('\nedge cases');
storage.setItem(key('session-D'), JSON.stringify({ draft: '字符串形态的草稿', view: null, viewRequest: null }));
ok('a plain-string draft is mirrored too', backup() !== null && backup().chars === 8);

storage.setItem(key('session-E'), JSON.stringify({ draft: { text: '   ', references: [] }, view: null, viewRequest: null }));
check('a whitespace-only draft from another session does not spend the backup', backup().key, key('session-D'));

storage.setItem(key('session-F'), JSON.stringify({ draft: { text: '  ', references: [] } }));
check('a whitespace-only draft never becomes a backup of its own', backup().key, key('session-D'));

check('garbage in a draft key is tolerated', storage.getItem(key('session-G')), backup().raw);
storage.setItem(key('session-G'), 'not json at all');
check('garbage written to a draft key is ignored', backup().key, key('session-D'));

/* ------------------------------------------------------------------ *
 * 5. disposal restores the original storage methods                   *
 * ------------------------------------------------------------------ */

console.log('\ndisposal');
storage.setItem(BACKUP, JSON.stringify({ v: 1, at: 1, key: key('session-H'), raw: stateWith('残留'), chars: 2, preview: '残留' }));
const proto = Object.getPrototypeOf(storage);
const patchedGet = proto.getItem;
disposers.forEach((dispose) => dispose());
ok('the patched reader is gone', proto.getItem !== patchedGet);
check('after disposal a new session reads nothing again', storage.getItem(key('session-I')), null);

/* ------------------------------------------------------------------ */

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks');
process.exitCode = failures === 0 ? 0 : 1;
