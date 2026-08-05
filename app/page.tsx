import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import LogoutButton from './logout-button'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const isSuper = session.role === 'super'
  const isSearch = session.role === 'search'

  // An entry account works one block and should see which, on the screen
  // it lands on — the block is no longer something the phone remembers,
  // and getting it wrong is now impossible rather than merely unlikely.
  let blockName: string | null = null
  if (session.blockId) {
    const { data } = await supabaseAdmin
      .from('blocks')
      .select('name')
      .eq('id', session.blockId)
      .maybeSingle()
    blockName = (data?.name as string | undefined) ?? null
  }

  const tiles = [
    {
      href: '/entry',
      title: 'Vehicle Entry',
      sub: blockName ? `Record a vehicle in ${blockName}` : 'Record a vehicle registration number',
      color: 'bg-blue-600',
      show: !isSearch,
    },
    {
      href: '/search',
      title: 'Search Vehicle',
      sub: 'Find by number, phone, name or entry number',
      color: 'bg-emerald-600',
      show: true,
    },
    {
      href: '/entries',
      title: isSuper ? 'All Entries' : 'My Entries',
      sub: isSuper
        ? 'Any block — view, correct, delete, export'
        : `See and correct what ${blockName ?? 'this block'} has entered`,
      color: 'bg-indigo-600',
      show: !isSearch,
    },
    {
      href: '/dashboard',
      title: 'Dashboard',
      sub: 'See how full each block is',
      color: 'bg-slate-700',
      show: isSuper,
    },
    {
      href: '/admin/blocks',
      title: 'Manage Blocks',
      sub: 'Create blocks and set capacity',
      color: 'bg-purple-700',
      show: isSuper,
    },
    {
      href: '/admin/users',
      title: 'Manage Users',
      sub: 'Create PINs, set block access, turn accounts off',
      color: 'bg-rose-700',
      show: isSuper,
    },
  ].filter((t) => t.show)

  return (
    <main className="mx-auto max-w-lg p-5">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Event Parking</h1>
        <LogoutButton />
      </header>

      <div className="space-y-3">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`${t.color} block rounded-2xl px-6 py-7 text-white active:opacity-80`}
          >
            <div className="text-2xl font-bold">{t.title}</div>
            <div className="mt-1 text-white/80">{t.sub}</div>
          </Link>
        ))}
      </div>

      {/* Who this phone is signed in as. Worth being explicit now that a
          PIN identifies a person and a block rather than just unlocking
          the app — "why can I not enter?" should be answerable at a glance. */}
      <p className="mt-6 text-center text-sm text-slate-500">
        Signed in as <span className="font-medium text-slate-700">{session.name}</span>
        {blockName && <> · Block {blockName}</>}
        {isSearch && <> · view only</>}
      </p>
    </main>
  )
}
