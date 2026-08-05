import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import UsersClient from './users-client'

export default async function AdminUsersPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  // Super Admin only, and checked here rather than merely hidden — this
  // screen shows every PIN in the system.
  if (session.role !== 'super') redirect('/')

  return <UsersClient />
}
