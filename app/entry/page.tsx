import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import EntryClient from './entry-client'

export default async function EntryPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  // A help-desk account may look things up and nothing else. Hiding the
  // tile is not enough — the URL is guessable.
  if (session.role === 'search') redirect('/search')

  // The block comes from the account, not from the browser. The Super
  // Admin has no block of their own and still gets to pick one.
  return <EntryClient fixedBlockId={session.blockId} />
}
