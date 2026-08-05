import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import EntriesClient from './entries-client'

// An entry account sees its own block; the Super Admin sees any block and
// can delete and export. A help-desk account has no business here at all —
// it may search for a vehicle, not read out the whole list.
export default async function EntriesPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role === 'search') redirect('/search')

  return <EntriesClient isSuper={session.role === 'super'} fixedBlockId={session.blockId} />
}
