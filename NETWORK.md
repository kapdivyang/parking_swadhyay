# The network problem — what actually broke, and what to do about it

Written after the field trial where more than a lakh people arrived together
and the app became unusable.

**Status: option A is built and live** (4 August 2026). Search now answers
from the phone's own copy of the table and keeps working with no signal.
Options C and D below are still open, and C is still the cheapest win
available — it is arrangements, not code.

---

## 1. Entry was never the problem. Search was.

Worth being precise about this, because the instinct is to "make the app
work offline" and it already does — on one side only.

**Vehicle entry is offline-first today.** An entry is written to the phone's
own IndexedDB and the operator gets their confirmation from the device, not
from the server. Sync happens in the background every 10 seconds. An entry
admin can work for an hour with no signal at all and lose nothing.

**Search is entirely online.** Every keystroke past the third fires a request
and waits for the round trip. Nothing is cached, and nothing can be — the
answer comes from a database the phone has never seen.

Now put the numbers on it. At exit time:

| | |
|---|---|
| Visitors leaving | ~1,00,000 |
| Help desk search operators | 25–30 |
| Searches per operator, per hour | 60–120 |
| **Requests hitting the server, per hour** | **~2,000–3,600** |

That request rate is nothing for Supabase. **The server was never the
bottleneck.** What broke is the last 500 metres: a lakh of phones camped on
the same two or three cell towers, and our 30 operators competing with all of
them for airtime. Every search sat in a queue behind somebody's video call.

This is why "upgrade the database" or "add caching on the server" would have
changed nothing.

---

## 2. The four options, honestly compared

### A. Offline search snapshot — **built, 4 August 2026**

Give every search phone the whole answer up front, and stop asking the
network at exit time altogether.

The dataset is far smaller than it feels. What a search actually needs is:
vehicle number, block, entry number, landmark, name, phone, village. That is
roughly 60–80 bytes per vehicle:

| Entries | Raw | Gzipped over the wire |
|---|---|---|
| 10,000 | ~700 KB | ~200 KB |
| 50,000 | ~3.5 MB | ~1 MB |
| 1,00,000 | ~7 MB | ~2 MB |

Seven megabytes sits in IndexedDB without complaint, and searching it in
memory is instant — faster than the network ever was, even on a good day.

How it would work:

1. On opening `/search`, the phone downloads everything entered so far, once.
2. Every 60 seconds it asks only for **what changed since last time**
   (`?since=<timestamp>`) — a few kilobytes, not the whole set again.
3. All searching runs against the local copy. No request, no waiting.
4. A banner shows how fresh the data is: *"Updated 40 seconds ago"*, turning
   amber past two minutes so nobody trusts a stale phone by accident.
5. If the network is gone entirely, search keeps working on whatever the
   phone last had — which at exit time is almost everything, because entry
   finished hours earlier.

**The one honest limitation:** a vehicle entered in the last 60 seconds may
not be on the searching phone yet. At exit time this does not matter — entry
stopped long before. During the event it would mean an occasional "not found"
for a car that just arrived, so the screen must offer a **"Search the server
directly"** button as a fallback, which is one request and works whenever
there is signal.

**Measured on the real 1673 entries:**

| | |
|---|---|
| First pull | 162 KB, two pages, ~99 bytes a vehicle |
| Poll with nothing new | ~2 KB |
| Poll carrying one new entry | ~2.2 KB |
| Projected first pull at 1,00,000 entries | ~10 MB raw, well under that gzipped |

**What it does *not* solve.** A vehicle entered in the last 60 seconds is not
on the searching phone yet. Two things cover that: a search that comes back
empty is automatically re-asked of the server, and the freshness label on
screen says how old the phone's copy is. At exit time neither matters — entry
stopped hours earlier.

**Built as:** `app/api/search/snapshot/route.ts` (the delta endpoint),
`lib/snapshot.ts` (IndexedDB store, sync, and the local matching), and the
wiring in `app/search/search-client.tsx`.

Two things in there are worth knowing before changing any of it:

- **The cursor must come from the database, not from `new Date()`.** The web
  server and Postgres do not share a clock. A cursor stamped by the server,
  even two seconds fast, sits *after* rows written a moment later — and those
  rows are then skipped permanently. This was a real bug during the build:
  new entries silently never reached the phones.
- **Rows and deletions need separate cursors.** Sharing one means that on a
  quiet stretch, when nothing is being entered, every past deletion is resent
  on every poll forever. Also a real bug, also caught by the tests.

**Kept honest by:** `scripts/parity-search.mjs`, which runs the actual client
matching code against the actual snapshot endpoint and compares every query
with `/api/search`. If offline and online searching ever drift apart, that
test fails. Run it whenever either side changes.

### B. An on-site server on local WiFi

A laptop running Postgres and the app, with WiFi routers around the ground.
Phones talk to it over the LAN and never touch the internet.

This genuinely removes the dependency, and it is what large events do. It is
also the wrong thing to attempt now:

- WiFi coverage across a parking ground is an infrastructure job — access
  points, power, and cabling, not an afternoon of configuration.
- One laptop becomes a single point of failure with a hundred phones on it.
- Syncing back to Supabase afterwards is a whole second system.
- Everything installed on the volunteers' phones would need repointing.

Worth planning for a future event with proper lead time. Not worth the risk
of introducing it for this one.

### C. Harden the network itself — *do this regardless*

Not code. This is the part that would have helped most on the day, and it
costs almost nothing:

- **A wired connection at the help desk if the venue has one at all.** A
  single ethernet line beats every 4G optimisation in this document.
- **Two or three 4G routers on *different* carriers** (Jio / Airtel / Vi).
  When one network saturates, the others usually have not. Put the search
  operators on their own router, separate from everyone else.
- **Keep the search operators physically together**, close to their router
  and away from the crowd. Signal quality falls off fast with distance and
  bodies.
- **Power banks for every router and phone.** A dead router is
  indistinguishable from a dead network at 8 pm.
- **Test at the actual spot, at the actual hour** — not at 11 am from the
  office. Cell congestion is a time-of-day problem.

### D. Trim what goes over the wire — *small, cheap, do it anyway*

- The block-list poll on every entry phone runs every 30 s. At 100 phones
  that is 200 requests a minute for a capacity bar. **60 s is plenty.**
- Search sends a request 250 ms after a keystroke. On a congested network
  that stacks up requests that are already obsolete. **400 ms, and cancel the
  previous one.**
- The search response carries every column. Half of them are never shown in
  the compact list. **Send what is drawn.**

Each is a small win. Together they cut the traffic meaningfully, and none of
them takes more than an hour.

---

## 3. What I would actually do

**Done:** A — the offline search snapshot.

**Still to do, in this order:**

1. **C — network hardening.** No code, and still the biggest remaining
   effect. Even with A built, the phones need signal to *fill* their copy in
   the first place, and entry admins need it to sync. Arrange this.
2. **Test A with real operators on the ground** — 30 phones filling their
   copy at once, then aeroplane mode, then search. Not the night before.
3. **D — trim the remaining traffic.** An hour of work, no risk.

**Not now:** B. Revisit it for an event where there is time to do the WiFi
survey properly.

---

## 4. If it happens again mid-event

Worth printing and handing to whoever runs the help desk:

- **Search keeps working.** Each phone holds its own copy and answers from it.
  The label under the search box says how many vehicles it has and how long
  ago it last updated — if it turns amber, the copy is over two minutes old,
  which at exit time is still perfectly usable.
- Search operators move to the router with the best signal; do not spread out.
- A phone that has *never* opened `/search` on a working network has no copy
  yet. Open the search screen on every help-desk phone before the crowd
  arrives and wait for "N vehicles on this phone" to appear.
- **Entry admins do not need to do anything.** Their entries are safe on their
  phones and will sync when signal returns. Tell them this explicitly, or
  somebody will start writing on paper "to be safe" and that data will be
  lost.
- Keep the `/tv` display on the one connection you trust most — it polls
  continuously and will otherwise fight the search operators for airtime.

---

## 5. What was already ruled out, and why it is still worth reconsidering

**Public QR self-search** was declined, and that decision is what puts the
entire exit-time load on 30 operators. A QR code on the parking slip that a
visitor scans to find their own block would move most of that load onto the
visitors' own phones and their own carriers — which is exactly the resource
that scales with crowd size instead of against it.

It brings a real privacy question with it: a lookup by vehicle number alone
would let anybody find anybody. That is answerable — plate plus the last four
digits of the mobile, or a one-time token in the QR itself, so a visitor can
only ever look up their own vehicle.

Worth revisiting. It is the only option here that gets *cheaper* as the crowd
gets larger.
