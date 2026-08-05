import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import BlocksClient from './blocks-client'

export default async function AdminBlocksPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role !== 'super') redirect('/')
  return <BlocksClient />
}
