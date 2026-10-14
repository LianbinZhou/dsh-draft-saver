/**
 * Browser half of dsh-draft-saver.
 *
 * The problem it solves
 * ---------------------
 * The Harness composer draft is persisted per Session, under
 * `dsh.conversation.<sessionId>`. Clicking "New Session" always creates a
 * *fresh* blank Session (the reuse path is reserved for workspace reconnection),
 * and a blank Session is filtered out of the sidebar. So the moment you switch
 * away from a brand-new Session you typed into, that Session still exists on
 * disk with your draft under its own key — but there is no entry left to open
 * it again, and the next "New Session" is a different id. On screen the text is
 * simply gone.
 *
 * What this plugin does
 * ---------------------
 * One draft, not one per Session. Two guarded operations around the draft keys:
 *
 *  1. Every draft write is mirrored into one global backup key
 *     (`dsh-draft-saver.backup.v1`), which is therefore the newest unsent text.
 *     A Session rehydrating the copy it still held writes back the value it was
 *     handed, which is recognised and leaves the backup alone. Emptying the
 *     draft where it lived makes "empty" the newest draft.
 *
 *  2. Every draft read answers with that newest draft, so whichever Session you
 *     open shows the last thing you typed, in full. The Harness then imports it
 *     through its own ordinary rehydration path, so the text reappears in the
 *     composer the same way a saved draft always does. Nothing here touches the
 *     editor, which keeps the IME and reference-chip behaviour of the official
 *     path.
 *
 * A notice strip in `conversation.input.overlay` reports a restoration and
 * offers to drop the recovered text, so the user always decides its fate.
 *
 * It lives in the composer's floating layer, never in `conversation.input.dock`:
 * a bare entry in that strip shifts the whole conversation on the first
 * keystroke of an IME composition.
 *
 * Why patch storage instead of using the draft API
 * ------------------------------------------------
 * The session slots carry `inputActions` and `useInput`, but no Session id and
 * no "is this Session blank" fact, so an in-API restore cannot tell a brand-new
 * Session from a Session the user deliberately emptied. The storage guard sees
 * exactly the read that DSH itself performs, needs no private service, and
 * reuses the official import path. Storage access is wrapped in try/catch
 * everywhere: a plugin must never be able to break the composer.
 */

window.__ModuleLoader__.load({
  id: 'dsh-draft-saver',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const NS = 'dsh-draft-saver';

    /** Conversation store prefix, from the Harness conversation package. */
    const DRAFT_PREFIX = 'dsh.conversation.';
    /** One global backup slot; it holds the newest unsent draft, not a history. */
    const BACKUP_KEY = 'dsh-draft-saver.backup.v1';
    /** Composer floating layer: a closed entry there is the normal state. */
    const NOTICE_SLOT = 'conversation.input.overlay';
    const NOTICE_ID = 'draft-saver.notice';

    const ZH = {
      notice: '已恢复上次未发送的草稿（{chars} 字）',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      clear: '清空',
      dismiss: '知道了',
      hint: '来自上一个会话、还没发送的内容；你可以直接改、发出去，或点清空丢掉它。',
    };
    const EN = {
      notice: 'Restored an unsent draft ({chars} chars)',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      clear: 'Clear',
      dismiss: 'Got it',
      hint: 'Text from an earlier session that was never sent; edit it, send it, or clear it away.',
    };

    /* ------------------------------------------------------------------ *
     * pure helpers                                                        *
     * ------------------------------------------------------------------ */

    /**
     * Decode a persisted draft value: a plain string, or a semantic snapshot.
     * `ok` separates "this really is an empty draft" from "this value is not a
     * draft at all", which the write path must treat differently.
     */
    function readDraft(raw) {
      try {
        const state = JSON.parse(String(raw));
        const draft = state && typeof state === 'object' ? state.draft : undefined;
        if (typeof draft === 'string') return { ok: true, text: draft };
        if (draft && typeof draft === 'object' && typeof draft.text === 'string') return { ok: true, text: draft.text };
        return { ok: false, text: '' };
      } catch (err) {
        return { ok: false, text: '' };
      }
    }

    /** Plain text of a persisted draft value; '' when it is not a draft. */
    function draftTextOf(raw) {
      return readDraft(raw).text;
    }

    /** Single-line head of a draft, for the notice tooltip. */
    function previewOf(text) {
      const flat = String(text).replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
    }

    /**
     * Put text on the clipboard. The async Clipboard API needs a secure context
     * and a user gesture; the hidden-textarea fallback covers what it refuses.
     * Resolves to whether the copy landed, so the strip can say so.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (err) {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const done = document.execCommand('copy');
        document.body.removeChild(area);
        return done === true;
      } catch (err) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * restoration notice bus                                              *
     * ------------------------------------------------------------------ */

    /** Newest restoration fact, or null once the user dismissed it. */
    let notice = null;
    const noticeListeners = new Set();

    function publishNotice(next) {
      notice = next;
      noticeListeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error('[dsh-draft-saver] notice listener failed', err);
        }
      });
    }

    /* ------------------------------------------------------------------ *
     * the storage guard                                                   *
     * ------------------------------------------------------------------ */

    /** Active uninstaller, so apply/dispose stays idempotent. */
    let uninstallGuard = null;

    function installGuard() {
      if (uninstallGuard) return uninstallGuard;
      if (typeof localStorage === 'undefined') return () => {};
      const proto = Object.getPrototypeOf(localStorage);
      if (!proto || typeof proto.getItem !== 'function' || typeof proto.setItem !== 'function') return () => {};

      const origGet = proto.getItem;
      const origSet = proto.setItem;
      const origRemove = proto.removeItem;

      /* Backup IO always targets localStorage through the ORIGINAL methods:
       * going through the patched pair here would recurse. */
      function backupRead() {
        try {
          const raw = origGet.call(localStorage, BACKUP_KEY);
          if (raw === null) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') return null;
          if (typeof parsed.raw !== 'string' || typeof parsed.key !== 'string') return null;
          return parsed;
        } catch (err) {
          return null;
        }
      }

      function backupWrite(record) {
        try {
          origSet.call(localStorage, BACKUP_KEY, JSON.stringify(record));
        } catch (err) {
          /* Quota or private mode: the guard simply stays out of the way. */
        }
      }

      function backupDrop() {
        try {
          if (typeof origRemove === 'function') origRemove.call(localStorage, BACKUP_KEY);
        } catch (err) {
          /* ignore */
        }
      }

      /* Last value handed to the Harness for each draft key. A session that
       * reads its stored draft and writes the very same value back is
       * rehydrating, not typing — and that write must never overwrite a newer
       * backup with an older draft. */
      const lastRead = new Map();

      /** Mirror a draft write: it becomes the newest draft for every composer. */
      function onWrite(key, value) {
        const parsed = readDraft(value);
        if (!parsed.ok) return;
        const seen = lastRead.get(key);
        const text = parsed.text;
        const existing = backupRead();
        if (text.trim() !== '') {
          /* The value this Session was handed, written back unchanged: the
           * composer is rehydrating, not the user typing, so the copy it still
           * held must not replace a newer draft. Comparing draft text rather
           * than the whole stored JSON keeps this working when the store
           * re-serializes a value it has just parsed. */
          if (typeof seen === 'string' && draftTextOf(seen) === text) return;
          if (existing && existing.key === key && existing.raw === value) return;
          backupWrite({ v: 1, at: Date.now(), key, raw: value, chars: text.length, preview: previewOf(text) });
          return;
        }
        /* An empty draft — the send that consumed it, or the user clearing it.
         * Clearing is a deliberate act on ONE composer, so emptiness is never
         * pushed anywhere: the other composers keep whatever they hold. The
         * shared draft simply stops existing, because the user is done with it.
         * Whitespace-only text and unreadable values are not "empty". */
        if (text === '' && existing) backupDrop();
      }

      /** Answer every draft read with the one newest unsent draft. */
      function decideRead(key, raw) {
        const backup = backupRead();
        if (!backup) return raw;
        const newest = draftTextOf(backup.raw);
        const own = raw === null ? '' : draftTextOf(raw);
        if (own === newest) return raw;
        if (newest.trim() === '') return raw;
        publishNotice({ at: Date.now(), chars: backup.chars, preview: backup.preview, text: newest });
        return backup.raw;
      }

      /** Read, remember what was answered, and let the write path tell a
       * rehydration apart from an edit. */
      function onRead(key, raw) {
        const answer = decideRead(key, raw);
        if (lastRead.size > 512) lastRead.clear();
        lastRead.set(key, answer);
        return answer;
      }

      proto.setItem = function patchedSetItem(key, value) {
        const result = origSet.call(this, key, value);
        const name = String(key);
        if (name.startsWith(DRAFT_PREFIX)) {
          try {
            onWrite(name, String(value));
          } catch (err) {
            console.error('[dsh-draft-saver] draft mirror failed', err);
          }
        }
        return result;
      };

      proto.getItem = function patchedGetItem(key) {
        const raw = origGet.call(this, key);
        const name = String(key);
        if (!name.startsWith(DRAFT_PREFIX)) return raw;
        try {
          return onRead(name, raw);
        } catch (err) {
          console.error('[dsh-draft-saver] draft restore failed', err);
          return raw;
        }
      };

      uninstallGuard = () => {
        proto.getItem = origGet;
        proto.setItem = origSet;
        uninstallGuard = null;
      };
      return uninstallGuard;
    }

    /* ------------------------------------------------------------------ *
     * the restoration notice                                              *
     * ------------------------------------------------------------------ */

    function DraftSaverNotice(props) {
      const [snapshot, setSnapshot] = useState(notice);
      /** '' | 'copied' | 'failed' — shown on the copy button for a moment. */
      const [copied, setCopied] = useState('');

      useEffect(() => {
        const sync = () => setSnapshot(notice);
        noticeListeners.add(sync);
        sync();
        return () => {
          noticeListeners.delete(sync);
        };
      }, []);

      /* The strip is informational: it retires on its own so it never sits on
       * top of the composer while the user works on the restored text. Acting on
       * it republishes the notice, which restarts this timer. The draft itself
       * stays in the composer either way. */
      useEffect(() => {
        if (!snapshot) return undefined;
        const timer = setTimeout(() => publishNotice(null), 20000);
        return () => clearTimeout(timer);
      }, [snapshot]);

      const readInput = props.useInput;
      const input = typeof readInput === 'function' ? readInput((s) => s) : null;
      /* null means "the draft is unknown", which is not the same as "". */
      const draft = input && typeof input.draft === 'string' ? input.draft : null;
      const actions = props.inputActions;
      const t = props.t;

      /* The strip belongs to the very draft it restored, and only lives while
       * that draft is in the composer: once the user clears or sends it, there
       * is nothing to say. A session slot carries no Session id (InputState has
       * none), so the restored text itself is the identity — a different
       * Session's composer holds a different draft and stays quiet. */
      const mine =
        snapshot &&
        typeof snapshot.text === 'string' &&
        snapshot.text !== '' &&
        draft !== null &&
        (draft === snapshot.text || draft.startsWith(snapshot.text));
      if (!mine) return null;

      const button = {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        padding: '2px 8px',
        borderRadius: '7px',
        cursor: 'pointer',
      };

      return h(
        'div',
        {
          'data-draft-saver': 'notice',
          style: {
            position: 'fixed',
            left: '50%',
            bottom: '104px',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            maxWidth: 'min(620px, calc(100vw - 32px))',
            padding: '8px 12px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            background: 'var(--dsw-alias-bg-overlay, rgba(28,28,30,0.96))',
            color: 'var(--dsw-alias-label-primary, #f5f5f5)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.3)',
            fontSize: '12.5px',
            lineHeight: '1.4',
            zIndex: 60,
          },
        },
        [
          h(
            'span',
            { key: 'text', title: snapshot.preview || '', style: { flex: '1 1 auto', minWidth: '0' } },
            t('notice', { chars: snapshot.chars }),
          ),
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              style: button,
              title: t('hint'),
              onClick: () => {
                /* Copy what the composer holds right now, not the text the
                 * strip was raised with. */
                copyText(draft).then((done) => {
                  setCopied(done ? 'copied' : 'failed');
                  /* Republishing restarts the strip's own retirement timer. */
                  publishNotice(Object.assign({}, snapshot));
                  setTimeout(() => setCopied(''), 1800);
                });
              },
            },
            copied === 'copied' ? t('copied') : copied === 'failed' ? t('copyFailed') : t('copy'),
          ),
          h(
            'button',
            {
              key: 'clear',
              type: 'button',
              style: button,
              title: t('hint'),
              onClick: () => {
                try {
                  if (actions && typeof actions.setDraft === 'function') actions.setDraft('');
                } catch (err) {
                  console.error('[dsh-draft-saver] clearing the restored draft failed', err);
                }
                publishNotice(null);
              },
            },
            t('clear'),
          ),
          h(
            'button',
            { key: 'dismiss', type: 'button', style: button, onClick: () => publishNotice(null) },
            t('dismiss'),
          ),
        ],
      );
    }

    /* ------------------------------------------------------------------ *
     * plugin body                                                         *
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'draft-saver: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'draft-saver: en dictionary');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => installGuard(), 'draft-saver: draft backup guard');

        ctx.effect(
          () =>
            ctx.slots.inject(NOTICE_SLOT, () =>
              ctx.slots.register({ name: NOTICE_SLOT, id: NOTICE_ID, order: 320 }, function DraftSaverNoticeEntry(props) {
                return h(DraftSaverNotice, Object.assign({}, props, { t }));
              }),
            ),
          'draft-saver: restored-draft notice',
        );
      },
    };
  },
});
