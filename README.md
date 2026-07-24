# ohana-lending

Loan manager PWA (records, payment schedules, cash flow, agreements). No build
step — `index.html` loads React + Babel standalone and runs `app.js` directly.
Data lives in Supabase; the app is installable and works offline.

## PWA architecture

| Piece | File | Notes |
|---|---|---|
| Manifest | `manifest.json` | standalone display, maskable icons, 3 launcher shortcuts (`?tab=…`) |
| Service worker | `sw.js` | two caches: `ohana-shell-<VERSION>` (our code) and `ohana-lib-v1` (CDN libs) |
| Registration + update detection | `index.html` | fires a `sw-update-ready` window event |
| Offline UI, outbox, install/update prompts | `app.js` | see below |

### Caching

- **Navigations and app code** (`index.html`, `app.js`, `manifest.json`) —
  network-first with a 4 s deadline, falling back to cache, so a deploy lands
  immediately but a weak signal never leaves a blank screen.
- **Same-origin assets** (icons, `tailwindcss.js`) — cache-first.
- **CDN libraries** — stale-while-revalidate. Several URLs float (`@latest`,
  `@2`, `@5`), so cache-first-forever would pin them permanently.
- **Supabase** — never intercepted.

The library cache is deliberately *not* versioned with the app: shipping an app
update no longer re-downloads ~5 MB of React/Babel/charts over mobile data.

### Releasing an update

Bump `VERSION` in `sw.js`. The new worker installs but **does not** call
`skipWaiting()` on its own — the app shows an "Update ready" banner and only
swaps when the user taps Update (so nobody loses a half-entered payment).
`index.html` reloads once on `controllerchange`.

### Offline behaviour

- **Reads** — every successful fetch is snapshotted to `localStorage`
  (`ohana_snapshot_v1`, minus ID photos and agreements, which would blow the
  quota). A cold launch with no signal paints real data instead of an empty shell.
- **Access check** — `is_approved` / `is_admin` results are cached per user, so
  losing signal doesn't lock staff out of their own records. This only unlocks
  the local UI; RLS still enforces everything server-side.
- **Writes** — payments, cash entries and queue additions go to an IndexedDB
  outbox when the network is unreachable, and are replayed on reconnect (also on
  `online`, on pull-to-refresh, on Background Sync wake-up, and on next launch).
  Each queued row carries a client-generated UUID, so a replayed row that
  actually landed collides on the primary key (`23505`) instead of double-posting.
  Queued rows show a **Queued** chip and are included in balances immediately.
- **Online-only** — creating/editing loans, agreements, ID photos, and deletes of
  already-synced rows. These need the server (ref allocation, storage), so they
  fail with a clear message rather than queueing.

Failures that are *not* network failures (RLS, validation) are never queued —
replaying them would only repeat the rejection.
