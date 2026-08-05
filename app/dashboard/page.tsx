import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import DashboardClient from './dashboard-client'

export default async function DashboardPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  // Super Admin only. Hiding the tile is not enough — the URL is guessable.
  if (session.role !== 'super') redirect('/')
  return <DashboardClient />
}
