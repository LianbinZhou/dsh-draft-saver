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
 * Two guarded operations around the draft keys, and nothing else:
 *
 *  1. Every non-empty draft write is mirrored into one global backup key
 *     (`dsh-draft-saver.backup.v1`). A write that *empties* the very Session the
 *     backup came from means the user sent or deleted it, so the backup is spent
 *     and dropped.
 *
 *  2. A draft read that would answer "no draft" — a Session whose key is absent
 *     or already empty — returns the backup instead, when the backup came from a
 *     *different* Session. The Harness then imports it through its own ordinary
 *     rehydration path, so the draft reappears in the composer the same way a
 *     saved draft always does. Nothing here touches the editor, which keeps the
 *     IME and reference-chip behaviour of the official path.
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
    /** Sessions whose composer is showing a borrowed draft rather than their own. */
    const BORROWED_KEY = 'dsh-draft-saver.borrowed.v1';
    /** Sessions the user actually typed a draft in; their text is never replaced. */
    const OWNED_KEY = 'dsh-draft-saver.owned.v1';
    /** Composer floating layer: a closed entry there is the normal state. */
    const NOTICE_SLOT = 'conversation.input.overlay';
    const NOTICE_ID = 'draft-saver.notice';

    const ZH = {
      notice: '已恢复上次未发送的草稿（{chars} 字）',
      clear: '清空',
      dismiss: '知道了',
      hint: '来自上一个会话、还没发送的内容；你可以直接改、发出去，或点清空丢掉它。',
    };
    const EN = {
      notice: 'Restored an unsent draft ({chars} chars)',
      clear: 'Clear',
      dismiss: 'Got it',
      hint: 'Text from an earlier session that was never sent; edit it, send it, or clear it away.',
    };

    /* ------------------------------------------------------------------ *
     * pure helpers                                                        *
     * ------------------------------------------------------------------ */

    /** Plain text of a persisted draft value: a string, or a semantic snapshot. */
    function draftTextOf(raw) {
      try {
        const state = JSON.parse(String(raw));
        const draft = state && typeof state === 'object' ? state.draft : undefined;
        if (typeof draft === 'string') return draft;
        if (draft && typeof draft === 'object' && typeof draft.text === 'string') return draft.text;
        return '';
      } catch (err) {
        return '';
      }
    }

    /** Single-line head of a draft, for the notice tooltip. */
    function previewOf(text) {
      const flat = String(text).replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
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

      /* Sessions whose composer is only showing a draft they borrowed from the
       * backup. They keep following the newest unsent text until the user
       * types something of their own there; a draft the user typed in a Session
       * is that Session's own and is never overwritten by another Session. */
      function borrowedRead() {
        try {
          const raw = origGet.call(localStorage, BORROWED_KEY);
          if (raw === null) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
        } catch (err) {
          return [];
        }
      }

      function borrowedWrite(list) {
        try {
          origSet.call(localStorage, BORROWED_KEY, JSON.stringify(list.slice(-200)));
        } catch (err) {
          /* ignore */
        }
      }

      function borrow(key) {
        const list = borrowedRead();
        if (!list.includes(key)) borrowedWrite(list.concat([key]));
      }

      function release(key) {
        const list = borrowedRead();
        if (list.includes(key)) borrowedWrite(list.filter((item) => item !== key));
      }

      /* Sessions the user actually typed in: their draft is theirs, so the
       * history adoption below never touches them. */
      function ownedRead() {
        try {
          const raw = origGet.call(localStorage, OWNED_KEY);
          if (raw === null) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
        } catch (err) {
          return [];
        }
      }

      function ownedWrite(list) {
        try {
          origSet.call(localStorage, OWNED_KEY, JSON.stringify(list.slice(-200)));
        } catch (err) {
          /* ignore */
        }
      }

      function claimOwned(key) {
        const list = ownedRead();
        if (!list.includes(key)) ownedWrite(list.concat([key]));
      }

      function releaseOwned(key) {
        const list = ownedRead();
        if (list.includes(key)) ownedWrite(list.filter((item) => item !== key));
      }

      /** Mirror a draft write; an emptied owner Session spends the backup. */
      function onWrite(key, value) {
        const seen = lastRead.get(key);
        const text = draftTextOf(value);
        const existing = backupRead();
        if (text.trim() !== '') {
          /* The value this Session was handed, written back unchanged: a
           * rehydration, not an edit. It must not overwrite a newer draft, but
           * it does make this Session the owner, so that sending or clearing
           * the text THERE is what spends the backup. Comparing draft text
           * rather than the whole stored JSON keeps this working when the store
           * re-serializes a value it has just parsed. */
          if (typeof seen === 'string' && draftTextOf(seen) === text) {
            if (existing && existing.key !== key) backupWrite(Object.assign({}, existing, { key }));
            return;
          }
          /* Text the user actually typed here: this Session owns its draft from
           * now on, so it stops following the backup and is never adopted as a
           * borrower by the history rule below. */
          release(key);
          claimOwned(key);
          if (existing && existing.key === key && existing.raw === value) return;
          /* Remember the versions this backup has carried. A session still
           * holding one of them is holding a draft we handed out — see the read
           * path, which adopts such a session as a borrower. */
          const history = [];
          if (existing) {
            const previous = draftTextOf(existing.raw);
            if (previous.trim() !== '') history.push(previous);
            if (Array.isArray(existing.history)) history.push(...existing.history);
          }
          backupWrite({
            v: 1,
            at: Date.now(),
            key,
            raw: value,
            chars: text.length,
            preview: previewOf(text),
            history: history.filter((item, index) => history.indexOf(item) === index && item !== text).slice(0, 10),
          });
          return;
        }
        /* Emptied: neither a borrower nor an owner any more. */
        release(key);
        releaseOwned(key);
        if (existing && existing.key === key) backupDrop();
      }

      /** Answer a draft read with the newest unsent text. */
      function decideRead(key, raw) {
        const backup = backupRead();
        const own = raw !== null && draftTextOf(raw).trim() !== '';
        let borrowed = borrowedRead();
        /* A draft this Session holds that we know we once handed out is a debt
         * from an earlier run of the plugin, which had no borrower list: adopt
         * it, so it follows the newest text from now on. Text the user typed
         * never entered that history, so a Session's own draft stays its own. */
        if (own && !borrowed.includes(key) && !ownedRead().includes(key) && backup && Array.isArray(backup.history)) {
          if (backup.history.includes(draftTextOf(raw))) {
            borrow(key);
            borrowed = borrowed.concat([key]);
          }
        }
        /* A Session that only ever borrowed its draft keeps following the newest
         * one, even though an earlier borrow left a copy in its own key. */
        if (backup && backup.key !== key && borrowed.includes(key)) {
          const borrowedText = draftTextOf(backup.raw);
          if (borrowedText.trim() !== '') {
            publishNotice({ at: Date.now(), chars: backup.chars, preview: backup.preview, text: borrowedText });
            return backup.raw;
          }
        }
        if (own) return raw;
        /* Nothing of its own: hand it the backup, and remember that it is only
         * borrowing, so later edits keep reaching it too. */
        if (!backup || backup.key === key) return raw;
        const text = draftTextOf(backup.raw);
        if (text.trim() === '') return raw;
        borrow(key);
        publishNotice({ at: Date.now(), chars: backup.chars, preview: backup.preview, text });
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

      useEffect(() => {
        const sync = () => setSnapshot(notice);
        noticeListeners.add(sync);
        sync();
        return () => {
          noticeListeners.delete(sync);
        };
      }, []);

      /* The strip is informational: it retires on its own so it never sits on
       * top of the composer while the user works on the restored text. The
       * draft itself stays in the composer either way. */
      useEffect(() => {
        if (!snapshot) return undefined;
        const timer = setTimeout(() => publishNotice(null), 10000);
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
