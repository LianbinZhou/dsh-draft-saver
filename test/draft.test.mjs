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

/* The original writer, so a case can leave a draft behind exactly the way an
 * earlier page load would have: the guard is installed later, in apply(). */
const writeBehindTheGuard = Object.getPrototypeOf(storage).setItem;

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
  locale: {
    register: () => () => {},
    bind: () => (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
  },
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
 * helpers mirroring what the conversation store writes and reads       *
 * ------------------------------------------------------------------ */

const BACKUP = 'dsh-draft-saver.backup.v1';
const key = (id) => 'dsh.conversation.' + id;

/** The conversation store persists the whole state object as JSON. */
const stateWith = (text) => JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null });
const emptyState = JSON.stringify({ draft: { text: '', references: [] }, view: null, viewRequest: null });

function draftText(raw) {
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw);
    const draft = state && state.draft;
    if (typeof draft === 'string') return draft;
    if (draft && typeof draft.text === 'string') return draft.text;
    return '';
  } catch (err) {
    return '';
  }
}

/** Text of a read result; null stays "nothing was stored at all". */
const readText = (raw) => (raw === null ? '' : draftText(raw));

function backup() {
  const raw = storage.getItem(BACKUP);
  return raw === null ? null : JSON.parse(raw);
}

const newest = () => draftText(backup().raw);

/* ------------------------------------------------------------------ *
 * 1. one draft, shared by every composer                              *
 * ------------------------------------------------------------------ */

console.log('\none newest draft');
storage.setItem(key('s1'), stateWith('第一段'));
check('a typed draft becomes the newest draft', newest(), '第一段');
check('and remembers the composer it lives in', backup().key, key('s1'));

storage.setItem(key('s2'), stateWith('第二段'));
check('a later draft replaces it', newest(), '第二段');

console.log('\nevery composer shows the newest draft');
check('a session with no draft of its own is handed it', readText(storage.getItem(key('s3'))), '第二段');
/* A composer still holding an older draft from an earlier page load: written
 * behind the guard, because writing through it would itself be an edit. */
writeBehindTheGuard.call(storage, key('s4'), stateWith('很久以前写的'));
check('a session holding an older draft is handed it too', readText(storage.getItem(key('s4'))), '第二段');

/* ------------------------------------------------------------------ *
 * 2. an edit anywhere reaches everywhere                              *
 * ------------------------------------------------------------------ */

console.log('\nedits reach every composer');
storage.setItem(key('s5'), stateWith('第二段又长了一点'));
check('the edit is the newest draft', newest(), '第二段又长了一点');
check('an older session follows it', readText(storage.getItem(key('s4'))), '第二段又长了一点');

storage.setItem(key('s6'), stateWith('变短了'));
check('a shorter draft follows just as well', readText(storage.getItem(key('s4'))), '变短了');

/* ------------------------------------------------------------------ *
 * 3. the reported walk-through, step by step                          *
 * ------------------------------------------------------------------ */

console.log('\nthe reported walk-through');
storage.clear();

/* Step 1: type into a brand-new session. */
storage.setItem(key('w-new1'), stateWith('测试会话'));
check('step 1: the new session holds the draft', newest(), '测试会话');

/* Step 2: open an older session; it shows the draft. */
const stepA = storage.getItem(key('w-A'));
check('step 2: an older session shows the draft', readText(stepA), '测试会话');
storage.setItem(key('w-A'), stepA);

/* Step 3: extend it inside that older session. */
storage.setItem(key('w-A'), stateWith('测试会话测试会话第一次'));
check('step 3: the extension is the newest draft', newest(), '测试会话测试会话第一次');

/* Step 4: a new session shows the extension. */
check('step 4: a new session shows the extension', readText(storage.getItem(key('w-new2'))), '测试会话测试会话第一次');

/* Step 5: another older session shows it too. */
check('step 5: another older session shows it too', readText(storage.getItem(key('w-B'))), '测试会话测试会话第一次');

/* Step 6: back to the first older session — still the extension. */
check('step 6: the first older session still shows the extension', readText(storage.getItem(key('w-A'))), '测试会话测试会话第一次');

/* One more round on top of the extension. */
const stepB = storage.getItem(key('w-B'));
storage.setItem(key('w-B'), stepB);
storage.setItem(key('w-B'), stateWith('测试会话测试会话第一次测试会话第二次'));
check('a second extension is the newest draft', newest(), '测试会话测试会话第一次测试会话第二次');
check('the first older session follows again', readText(storage.getItem(key('w-A'))), '测试会话测试会话第一次测试会话第二次');
check('and so does every new session', readText(storage.getItem(key('w-new3'))), '测试会话测试会话第一次测试会话第二次');

/* ------------------------------------------------------------------ *
 * 4. rehydration is not an edit                                       *
 * ------------------------------------------------------------------ */

console.log('\nrehydration');
storage.clear();
storage.setItem(key('r1'), stateWith('第一版'));
const handed = storage.getItem(key('r2'));
check('a composer is handed the newest draft', readText(handed), '第一版');

/* The store writes the value it was just handed straight back. */
storage.setItem(key('r2'), handed);
check('writing it back is not treated as an edit', backup().key, key('r1'));
check('and the text is unchanged', newest(), '第一版');

storage.setItem(key('r3'), stateWith('第二版'));
check('a later edit becomes the newest draft', newest(), '第二版');
check('and the earlier composer follows it', readText(storage.getItem(key('r2'))), '第二版');

/* ------------------------------------------------------------------ *
 * 5. clearing stays inside the composer it was clicked in             *
 * ------------------------------------------------------------------ */

console.log('\nclearing stays local');
storage.clear();
storage.setItem(key('c-A'), stateWith('A 自己的内容'));
storage.setItem(key('c-B'), stateWith('最新的内容'));
check('the newest draft is the second one', newest(), '最新的内容');

/* The user clears A, which is not where the newest draft lives. */
storage.setItem(key('c-A'), emptyState);
check('clearing drops the shared draft', backup(), null);
check('the other composer keeps its text', readText(storage.getItem(key('c-B'))), '最新的内容');
check('an empty composer stays empty', storage.getItem(key('c-C')), null);

/* Typing again starts a fresh shared draft. */
storage.setItem(key('c-D'), stateWith('清空后重新写的'));
check('typing again starts a new shared draft', newest(), '清空后重新写的');

/* Clearing the composer that owns the newest draft drops it the same way, and
 * still does not touch anyone else. */
storage.setItem(key('c-D'), emptyState);
check('clearing the newest draft drops it too', backup(), null);
check('and the untouched composer still holds its own text', readText(storage.getItem(key('c-B'))), '最新的内容');

/* ------------------------------------------------------------------ *
 * 6. edge cases                                                       *
 * ------------------------------------------------------------------ */

console.log('\nedge cases');
storage.clear();
storage.setItem(key('e-plain'), JSON.stringify({ draft: '字符串形态的草稿', view: null, viewRequest: null }));
check('a plain-string draft is mirrored', newest(), '字符串形态的草稿');

storage.setItem(key('e-blank'), JSON.stringify({ draft: { text: '   ', references: [] }, view: null, viewRequest: null }));
check('a whitespace-only draft is not an edit', newest(), '字符串形态的草稿');

storage.setItem(key('e-garbage'), 'not json at all');
check('garbage written to a draft key is ignored', newest(), '字符串形态的草稿');
check('garbage read from a draft key yields the newest draft', readText(storage.getItem(key('e-garbage'))), '字符串形态的草稿');

/* A copy left behind by an earlier page load must not resurrect itself. */
writeBehindTheGuard.call(storage, key('e-old'), stateWith('很旧的遗留'));
check('an old copy left on disk reads as the newest draft', readText(storage.getItem(key('e-old'))), '字符串形态的草稿');

/* A draft key with a non-draft object is read through untouched. */
storage.setItem(key('e-other'), JSON.stringify({ view: 'trajectory' }));
check('a key without a draft never becomes the newest draft', newest(), '字符串形态的草稿');

/* ------------------------------------------------------------------ *
 * 7. disposal restores the original storage methods                   *
 * ------------------------------------------------------------------ */

console.log('\ndisposal');
storage.setItem(BACKUP, JSON.stringify({ v: 1, at: 1, key: key('d1'), raw: stateWith('残留'), chars: 2, preview: '残留' }));
const proto = Object.getPrototypeOf(storage);
const patchedGet = proto.getItem;
disposers.forEach((dispose) => dispose());
ok('the patched reader is gone', proto.getItem !== patchedGet);
check('after disposal a new session reads nothing again', storage.getItem(key('d2')), null);

/* ------------------------------------------------------------------ */

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks');
process.exitCode = failures === 0 ? 0 : 1;
