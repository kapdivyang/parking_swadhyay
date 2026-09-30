# Event Parking System — Status

**Event date: 2 August 2026**

---

## Where things stand

Everything below is built, type-checked, and verified against the live
Supabase database. Not yet deployed — that is the next step.

### Screens

| Route | Who | What |
|---|---|---|
| `/login` | everyone | PIN entry |
| `/` | everyone | Home tiles (Manage Blocks only for Super Admin) |
| `/entry` | entry account | Vehicle entry for that account's block, offline queue |
| `/search` | everyone | Search by plate / phone / name / village / taluka / entry no. |
| `/entries` | entry account | Its own block's entries — view and correct |
| `/entries` | Super Admin | Any block, plus delete and CSV export |
| `/dashboard` | Super Admin | Live capacity per block |
| `/tv` | control room | Big auto-refreshing display |
| `/admin/blocks` | Super Admin | Create blocks, set capacity, Start Fresh |
| `/admin/users` | Super Admin | Create accounts, set block access, turn accounts off |

### Key behaviours

- **One account per person** — the Super Admin creates them, each with its own
  PIN and its own block. There is no shared PIN any more, and no block picker:
  a PIN says who you are and where you may write
- **An account can be switched off** — and it stops on its very next request,
  not at its next login
- **Offline entry** — writes to IndexedDB first, syncs every 10s and on reconnect
- **No duplicates** — `client_uuid` upsert means a retry over flaky network is ignored
- **Partial search** — "1234" finds the plate; last 4 digits of a phone also work
- **Village / taluka** — optional on entry, and searchable on their own. Village
  alone lists every vehicle from that village with its block; adding the taluka
  narrows it further. Any combination of number, village and taluka works, so an
  operator can search with whatever the visitor actually remembers.
- **Sticky village** — like the block, the last village/taluka stays filled in
  between entries, since vehicles arrive village by village
- **Shared spellings, and far less typing** — village, taluka, landmark and
  vehicle type all suggest what has already been entered, by anyone, on any
  phone. Commonest first, and the list opens on tapping the field, before a
  single letter: the usual entry is now a tap rather than a word. It also
  keeps "Sihor" and "sihore" from splitting one village in two. The lists
  are cached on the device, so they work with no signal, and a value used
  here is suggested here from the very next entry — no sync needed
- **Vehicle type** — optional, on the entry itself: car, bike, tractor.
  Free text with the commonest few as one-tap chips, not a fixed list; a
  vehicle nobody listed in advance must never be a reason an entry cannot
  be made. Sticky between entries like the village, since a block is
  usually one kind of vehicle. Included in the CSV export
- **Entry numbers** — 1, 2, 3… inside each block, handed out by the database.
  Searchable as `#7`, and shown on every search result
- **Landmark per entry** — "near light tower 4". The block says which field to
  walk to; this says where in it to look. Sticky like the village
- **Correcting an entry** — a block admin can edit any entry in their own
  block; deleting is Super Admin only, and the row is archived rather than lost
- **CSV export** — Super Admin, all blocks or one, streamed so size is no object
- **Offline search** — each search phone downloads the whole vehicle list and
  answers from its own copy. No network needed, and no request per keystroke.
  Refreshed every 60 seconds with only what changed (~2 KB)
- **Service worker** — `/entry`, `/search` and `/entries` open with no network
  (HTTPS only, so it activates after deploy, not on localhost over http)

---

## Migrations — 003 to 010 applied; **011 is not**

**`20260806000011_vehicle_type_and_suggestions.sql` has not been run yet.**
It adds `vehicles.vehicle_type` and `entry_suggestions()`, and the code in
this tree needs both. Additive only — no existing row or column is touched,
so the 1673 trial entries are unaffected:

```
npx supabase db push --linked
```

Run it **before** deploying, as always.

---

## Migrations — 003 to 010, all applied

**008, 009 and 010 were applied to the live database on 4 August 2026** with
`supabase db push --linked`, and verified against the real 1673 entries:
every entry numbered 1..n within its block, no duplicates, every counter
matching, nothing lost.

From 008 onwards the CLI tracks migration history, so new SQL goes in
**`supabase/migrations/`** with a timestamped name and is applied with:

```
npx supabase db push --linked
```

`supabase/008-entry-no-landmark-edit.sql` is the same file kept under the
older hand-run naming, for readability alongside 003–007. The copy in
`migrations/` is the one the CLI knows about — do not delete it, or a later
push would try to run 008 a second time.

003–007 were run by hand in the SQL Editor before the CLI took over, so they
are not in the history table. That is fine; they are already applied.

**Whatever comes next: run the SQL before deploying the code**, never after.
The other way round leaves the live site asking for columns that do not exist.

---

## Who can see what

There is no longer a shared PIN. Each person has an account, created by the
Super Admin at `/admin/users`, and their PIN decides both who they are and
which block they may write to.

| | Entry account | View only | Super Admin |
|---|---|---|---|
| `/entry` | its own block | **no** | any block |
| `/search` | yes | yes | yes |
| `/entries` | its own block | **no** | any block |
| Correct an entry | its own block | **no** | anywhere |
| Delete an entry | **no** | **no** | yes |
| CSV export | **no** | **no** | yes |
| `/dashboard`, `/admin/*` | **no** | **no** | yes |

Every one of those is checked on the server, not merely hidden on the home
screen — the URLs are easy to guess.

**The block now comes from the signed session, not from the browser.** This
is the part worth understanding. Before, a phone told the server which block
it belonged to and the server believed it, so the block "fence" only guarded
against mis-taps. Now the phone has no say: an entry account that asks to
write into another block has its entry written into its own block anyway.

**Turning an account off stops it on its next request**, not at its next
login. `getSession()` re-reads the account row every time. That costs one
indexed lookup per API call, and it is the whole reason the switch means
anything.

**The Super Admin is not in the accounts table.** Their PIN stays in
`SUPER_ADMIN_PIN`, so no row in the table — and no mistaken disable — can
lock out the one person who can re-enable accounts.

**Guessing is throttled.** Ten wrong PINs from one address and that address
is refused for fifteen minutes, correct PIN included. Without it, six digits
is a million guesses and a script has all afternoon.

**`APP_PIN` is dead.** Nothing reads it any more; it can be removed from
Vercel whenever convenient.

---

## Rolling out accounts — read before deploying

Deploying this **signs everybody out, and the old shared PIN stops working.**
Nobody can get back in until accounts exist. In this order, and not an hour
before the event:

1. Run the migration — `npx supabase db push --linked`
2. Deploy
3. Sign in with `SUPER_ADMIN_PIN`. This always works, which is exactly why
   it is not in the table
4. `/admin/users` → create an account per block admin and per help-desk
   operator. The screen names any block that has no account yet, so none
   gets missed
5. Hand out the PINs — each person needs only their own

Every phone asks for a PIN again on its next visit. Queued offline entries
are safe: they sit in the phone's own storage and sync once somebody signs in.

`/tv` is **not** locked down. It shows the same capacity figures as the
dashboard, but it is the control-room display and has no tile on the home
screen. Lock it the same way if that matters — one line in
`app/tv/page.tsx`, same as `app/dashboard/page.tsx`.

---

## One vehicle, one mobile, one entry

A unique index in the database, not just a check in the app — two admins at
two different gates are two different phones, and the database is the only
place they meet.

- The entry screen asks the server before saving, so the operator is told
  while the car is still in front of them.
- **The message always names which field clashed**, never a generic
  "duplicate" — the two cases are different conversations with the visitor:
  - `Vehicle number GJ06KA1234 is already entered — Block A-1`
  - `Mobile number 9812345678 is already used for GJ06KA1234`
- Offline there is nobody to ask, so the entry is queued. The server refuses
  it on sync, and it moves to a red **"not saved"** list on the entry screen
  rather than retrying forever.
- A resend of an entry the server already holds still counts as saved — that
  is a flaky network, not a duplicate.
- Scoped to `status = 'parked'`, so if exit marking is added later the number
  frees up on its own.

**Worth knowing before the field trial:** one mobile number can now cover only
one vehicle. A family arriving in two cars, or a driver giving their own number
for several vehicles, will be refused the second time. If that turns out to be
common on the ground, the fix is to drop `vehicles_phone_unique` — the vehicle
number rule is unaffected.

---

## Start Fresh — clearing the day's practice entries

`/admin/blocks` → **Start Fresh** (Super Admin only). Shows how many entries
would go, needs the words `CLEAR ALL` typed out, and cannot be reached with
the ordinary entry PIN — the server checks the role, not just the screen.

- **Blocks and their capacity are kept.** Losing the setup mid-event would be
  far worse than keeping a few practice entries. To remove a block, delete it
  individually on the same screen.
- **Every phone clears itself.** Each reset is stamped in the `resets` table,
  and the entry screen compares that stamp against the last one it saw every
  30 seconds. When it changes, the phone wipes its own offline queue and shows
  "Data was cleared — starting fresh". Without this a phone would keep
  refusing numbers it remembered, and would push cleared entries back up.
- A phone that is switched off during the reset picks it up when it next
  opens the app.
- Every reset is logged with its time and how many entries went, so "who
  cleared it and when" always has an answer.

---

## Deploying

The project is already linked (`.vercel/`) and the env vars are already
set, so a release is one command:

```
npx vercel --prod
```

**`npx`, not a bare `vercel`.** The CLI is a devDependency of this repo,
not a global install — a plain `vercel --prod` gives
"'vercel' is not recognized", which looks like a broken machine and is
only a missing prefix.

Two things worth remembering:

- **The SQL goes first, always.** Deploying code that reads a column the
  database does not have leaves the live site erroring for everyone. See
  the migrations section above.
- **A deploy alone changes nothing on a phone that is already open.** The
  service worker serves the cached screen until the next navigation, so
  check on a phone that has been closed and reopened.

First time on a new machine or a new project, instead:

1. `npx vercel login`
2. `npx vercel` — link the project
3. Set env vars in the Vercel dashboard (Settings → Environment Variables):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `SUPER_ADMIN_PIN`
4. `npx vercel --prod`

---

## Before the event — do not skip

- [ ] **Run migration 011** — `npx supabase db push --linked`, then deploy.
      Without it the entry screen has no vehicle type and no suggestions.
- [ ] **Change `SUPER_ADMIN_PIN`.** It is still `9999`. It is now the master
      key — the one PIN that always works and can re-enable every account —
      so it must not stay at a guessable default. Vercel dashboard; no
      redeploy needed beyond a restart. (`APP_PIN` is no longer read at all
      and can simply be deleted.)
- [ ] **Create the accounts** at `/admin/users` — one per block admin, one
      per help-desk operator. Nobody can sign in until this is done.
- [ ] **Export the trial data before clearing it** — `/entries` → Download CSV
      as Super Admin, or `node scripts/export-vehicles.mjs .env.local out.csv`
      for a JSON snapshot as well. **"Start Fresh" cannot be undone.**
- [ ] **Then Start Fresh** from `/admin/blocks` to clear the trial entries.
      Blocks and their capacity are kept; numbering restarts at 1.
- [ ] **Read `NETWORK.md`** and arrange the router / carrier setup in
      section 2C. It is the single biggest win available, and it is not code.
- [ ] **Install the app on every admin phone** (open the URL → browser menu →
      "Add to Home screen"). The service worker only caches after one visit.
- [ ] **Dry run with real volunteers** — 10 entries each, then a search by
      vehicle number and by entry number, then one correction from `/entries`.

---

## Entry numbers — the two things to know

**They come from the server, not the phone.** Two phones on one block would
otherwise both hand out number 12. So an entry made offline shows `#–` until
it syncs, and the number appears a moment later — usually within a second,
which is why the save banner upgrades itself to "GJ06KA1234 saved — Entry #42"
rather than showing the number straight away.

**They can occasionally skip a number.** A refused duplicate that reached the
database still consumed one. The sequence is a reliable identifier, not a
count — use the dashboard for counts.

"Start Fresh" resets every block back to 1.

---

## Correcting and deleting

- **Edit** — an entry account edits entries in its own block and nowhere
  else; the block comes from its account, not from the phone. The Super Admin
  is not fenced in that way. Saving takes two taps: the second spells out
  exactly which fields change, from what to what.
- **The block itself cannot be edited.** Entry numbers run 1, 2, 3… inside a
  block, so moving a vehicle across would duplicate a number or leave a hole.
  A vehicle entered under the wrong block is a delete and a re-entry.
- **Delete** — Super Admin only, and the vehicle number has to be typed back
  to confirm. The whole row is copied into `vehicle_deletions` first, so
  deleting the wrong entry is recoverable.
- **Worth being honest about the limit:** every volunteer holds the same entry
  PIN, so "their own block" means the block their phone is set to, which the
  phone itself reports. It is a guard against editing the wrong entry, not
  against a determined person. Anything stronger needs per-block logins.

---

## Offline search — what to know

Every phone that opens `/search` downloads the whole vehicle list into
IndexedDB and searches that. This is what fixes the failure from the field
trial: at exit time no search touches the network at all.

- **The first pull needs signal.** 162 KB for 1673 vehicles. Open `/search`
  on every help-desk phone before the crowd arrives and wait for
  "N vehicles on this phone" under the search box.
- **The label is the honesty check.** It shows the count and how long ago the
  copy was refreshed, and turns amber past two minutes or when offline.
- **A vehicle entered in the last minute may be missing.** When a search comes
  back empty and there is signal, the server is asked directly, automatically.
  Offline, the screen says so instead of letting "not found" stand.
- **Offline and online must agree.** `scripts/parity-search.mjs` runs the real
  client matching against the real endpoint and compares every query with
  `/api/search`. Run it whenever either side changes.

---

## Known gaps (deliberate, for after the event or if time allows)

- No public QR self-search (declined — so exit-time load lands entirely on the
  help desk; plan for 25-30 search operators). `NETWORK.md` argues for
  revisiting this; it is the only option that gets cheaper as the crowd grows.
- No SMS notification
- No exit marking, so capacity never frees up during the event

---

## Files worth knowing

- `supabase/schema.sql` — full schema, safe to re-run
- `supabase/002-grants.sql` — service_role permissions (already applied)
- `supabase/003-clear-test-data.sql` — pre-event cleanup
- `supabase/004-village-taluka.sql` — village/taluka columns + the new search
- `supabase/005-unique-vehicle-phone.sql` — the uniqueness rule
- `supabase/006-start-fresh.sql` — reset log + `reset_all_data()`
- `supabase/007-search-compat.sql` — bridge for the old one-argument search
- `supabase/008-entry-no-landmark-edit.sql` — entry numbers, landmark, edit /
  delete, entry-number search
- `supabase/009-changed-at-for-delta-sync.sql` — the column the offline
  snapshot pages through
- `supabase/010-user-accounts.sql` — accounts, per-block access, login throttling
- `supabase/migrations/20260806000011_vehicle_type_and_suggestions.sql` —
  `vehicles.vehicle_type`, and `entry_suggestions()` behind every suggested field
- `lib/suggest.ts` — the suggestion lists: cached on the device, merged with
  what this phone has just used, and matched as the operator types
- `app/components/suggest-input.tsx` — the field itself. Not `<datalist>`,
  and the comment at the top says why
- `NETWORK.md` — the crowd/network problem, analysed; option A now built
- `lib/auth.ts` — accounts, signed sessions, the block fence, rate limiting
- `lib/users.ts` — what makes a valid account (shared by create and edit)
- `lib/snapshot.ts` — the offline search copy: sync, storage, and matching
- `app/api/search/snapshot/route.ts` — the delta endpoint behind it
- `lib/queue.ts` — offline queue and sync (entry side)

### Scripts — all safe to re-run

Any that create data clean up after themselves and check the table is back
where it started. None of them touch the deletion archive's real rows.

| | |
|---|---|
| `verify-008.mjs` | entry numbering is intact on live data |
| `e2e-008.mjs` | create / list / search / edit / delete, then undo it all |
| `e2e-accounts.mjs` | every role boundary, the block fence, and disable-now |
| `e2e-ratelimit.mjs` | PIN guessing is throttled, and legitimate use is not |
| `parity-search.mjs` | offline search agrees with the database, query for query |
| `delta-snapshot.mjs` | new entries, edits and deletes reach a phone |
| `smoke-prod.mjs` | the deployed site is healthy (read-only) |
| `export-vehicles.mjs` | read-only CSV + JSON backup outside the app |

`parity-search.mjs` and `delta-snapshot.mjs` need the client code compiled
first, and a local server running:

```
npx next build
npx next start -p 3000
npx tsc lib/snapshot.ts --outDir .parity-build --module commonjs \
  --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop
node scripts/parity-search.mjs
node scripts/delta-snapshot.mjs
```
- `lib/auth.ts` — signed-cookie PIN sessions
- `.env.local` — keys and PINs (never committed)
