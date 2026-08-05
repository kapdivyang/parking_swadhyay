import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// CSV of every entry — Super Admin only.
//
// It holds names and mobile numbers for tens of thousands of people, so it
// is behind the Super Admin PIN, not the entry PIN that every volunteer has.
//
// The rows are streamed a page at a time rather than gathered into one big
// string: a hundred thousand entries would otherwise be held in memory
// twice over, and the download would not begin until the last row was read.

export const dynamic = 'force-dynamic'

const PAGE = 1000

const COLUMNS = [
  'block',
  'entry_no',
  'vehicle_no',
  'owner_name',
  'owner_phone',
  'village',
  'taluka',
  'landmark',
  'status',
  'entered_at_ist',
  'entered_at_utc',
  'edited_at_ist',
  'device_id',
  'id',
]

type Row = {
  id: string
  entry_no: number | null
  reg_no_display: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  landmark: string | null
  status: string
  entered_at: string
  updated_at: string | null
  device_id: string | null
  block_id: string
}

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// The event runs on Indian time and so does everyone reading the file.
// The UTC value is kept alongside it so nothing is lost.
function ist(ts: string | null): string {
  if (!ts) return ''
  return new Date(ts)
    .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
    .replace(',', '')
}

export async function GET(req: Request) {
  if ((await getSession())?.role !== 'super') {
    return Response.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const blockId = searchParams.get('block_id') ?? ''

  const { data: blocks, error: blockErr } = await supabaseAdmin.from('blocks').select('id, name')
  if (blockErr) {
    return Response.json({ error: blockErr.message }, { status: 500 })
  }
  const blockName = new Map((blocks ?? []).map((b) => [b.id as string, b.name as string]))

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // A byte-order mark, or Excel opens Gujarati and Hindi names as
      // mojibake. Written as an escape on purpose — the literal character
      // is invisible, and any editor or formatter could drop it without
      // anyone noticing until a file came back garbled.
      controller.enqueue(encoder.encode('\uFEFF' + COLUMNS.join(',') + '\r\n'))

      try {
        for (let from = 0; ; from += PAGE) {
          let q = supabaseAdmin
            .from('vehicles')
            .select(
              'id, entry_no, reg_no_display, owner_name, owner_phone, village, taluka, landmark, status, entered_at, updated_at, device_id, block_id',
            )
            .order('block_id', { ascending: true })
            .order('entry_no', { ascending: true })
            .range(from, from + PAGE - 1)

          if (blockId) q = q.eq('block_id', blockId)

          const { data, error } = await q
          if (error) throw new Error(error.message)

          const rows = (data ?? []) as Row[]
          for (const r of rows) {
            controller.enqueue(
              encoder.encode(
                [
                  blockName.get(r.block_id) ?? '',
                  r.entry_no ?? '',
                  r.reg_no_display,
                  r.owner_name,
                  r.owner_phone,
                  r.village,
                  r.taluka,
                  r.landmark,
                  r.status,
                  ist(r.entered_at),
                  r.entered_at,
                  ist(r.updated_at),
                  r.device_id,
                  r.id,
                ]
                  .map(esc)
                  .join(',') + '\r\n',
              ),
            )
          }

          if (rows.length < PAGE) break
        }
      } catch (e) {
        // The headers have already gone out, so the failure cannot be a
        // 500 any more. A last line saying so is better than a file that
        // simply stops halfway and looks complete.
        controller.enqueue(
          encoder.encode(`\r\n"EXPORT FAILED — this file is incomplete: ${(e as Error).message}"\r\n`),
        )
      }
      controller.close()
    },
  })

  const stamp = new Date().toISOString().slice(0, 10)
  const label = blockId ? (blockName.get(blockId) ?? 'block').replace(/[^a-zA-Z0-9]+/g, '-') : 'all'

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="parking-${label}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
