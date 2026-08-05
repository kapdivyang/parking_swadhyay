# Spec — Total Vehicles Card (Dashboard Summary)

Status: **specified, not yet implemented**
Added: 2026-07-28

## Kya chahiye

Dashboard par sabse upar ek summary card ho jisme **poore event ka total vehicle count**
dikhe. Abhi dashboard sirf block-by-block status dikhata hai (`block_status` view se) —
puura milakar kitni gaadiyan aayi hain, yeh kahin nahi dikhta.

## Requirements

### R1 — Card ki jagah
- Dashboard (`/dashboard`) par, block list ke **upar** ek summary card.
- Block cards ke grid se alag, visually alag treatment (bada number, prominent).

### R2 — Kaunse numbers
Card do numbers dikhayega:

| Label | Matlab | Source |
|---|---|---|
| **Total entries** | Ab tak kitni gaadiyan enter huin — `exited` bhi count mein | `count(*) from vehicles` |
| **Abhi parked** | Is waqt parking mein maujood | `count(*) from vehicles where status = 'parked'` |

Optional teesra derived number: **Nikal chuke** = Total − Parked.
Primary (bada) number = **Abhi parked**, kyunki event ke dauraan operationally wahi
kaam ka hai. Total entries secondary line mein.

### R3 — Kaun dekh sakta hai
- **Har logged-in admin** (`entry`, `search`, `super` — teeno roles).
- Koi role-gating nahi. Sirf session hona zaroori hai (baaki dashboard ki tarah).

### R4 — Live update
- Dashboard jis interval par blocks refresh karta hai, usi ke saath yeh count bhi
  refresh ho. Alag polling loop nahi banana.
- Ek hi API call se blocks + totals dono aaye, taaki 10,000-entry event mein
  extra round-trip na ho.

### R5 — Capacity ke saath context
- Agar sabhi active blocks ki `capacity` ka sum nikalna sasta hai, to card par
  `parked / total_capacity` aur fill percent bhi dikhaya jaye.
- Yeh already `block_status` rows se client-side sum karke mil jaata hai —
  iske liye alag query ki zaroorat nahi.

## Implementation notes

### Data source — recommended
`GET /api/blocks` ke response mein ek `totals` object add karein:

```jsonc
{
  "blocks": [ /* ...jaisa abhi hai... */ ],
  "totals": {
    "total_entries": 4821,   // count(*) from vehicles
    "parked": 3960,          // count(*) where status = 'parked'
    "exited": 861            // derived: total_entries - parked
  }
}
```

Do halke count queries — dono `head: true` ke saath, taaki rows transfer na hon:

```ts
const [all, parked] = await Promise.all([
  supabaseAdmin.from('vehicles').select('*', { count: 'exact', head: true }),
  supabaseAdmin.from('vehicles').select('*', { count: 'exact', head: true })
    .eq('status', 'parked'),
])
```

`vehicles_block_parked_idx` (partial index on `status = 'parked'`) parked count ko
cover karta hai. Full `count(*)` par Postgres sequential scan karega — 10k rows par
theek hai. Agar entries 1 lakh se upar jaayein to `count(*)` ko cache karna ya
ek aggregate view banana consider karein.

### Alternative — DB view
Agar API surface saaf rakhna ho to schema mein:

```sql
create or replace view vehicle_totals as
select
  count(*)                                        as total_entries,
  count(*) filter (where status = 'parked')       as parked,
  count(*) filter (where status = 'exited')       as exited
from vehicles;

grant select on vehicle_totals to service_role;
revoke all   on vehicle_totals from anon, authenticated;
```

Ek hi scan mein dono counts. Grants dena **zaroori** hai — is project mein
"Automatically expose new tables" band hai, warna service_role ko bhi permission
nahi milegi (dekhein `supabase/002-grants.sql`).

### Security
- Count sirf server route se aaye. Browser ki publishable key se `vehicles` par
  koi access nahi hai aur nahi hona chahiye — 10,000 logon ke naam/phone us table
  mein hain.
- `getSession()` check `/api/blocks` mein pehle se hai; totals usi guard ke peeche
  rahenge.

## Acceptance criteria

- [ ] Dashboard par block list ke upar summary card dikhta hai.
- [ ] Card par "Abhi parked" bada number aur "Total entries" secondary line hai.
- [ ] Teeno roles (`entry`, `search`, `super`) ko card dikhta hai.
- [ ] Bina login `/api/blocks` call karne par 401 — totals leak nahi hote.
- [ ] Nayi entry karne ke baad, agle dashboard refresh par dono numbers badhte hain.
- [ ] Gaadi exit mark karne par "Abhi parked" ghatta hai, "Total entries" nahi.
- [ ] Zero vehicles par card `0` dikhata hai, crash nahi karta.
