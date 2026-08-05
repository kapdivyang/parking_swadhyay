import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import TvClient from './tv-client'

export default async function TvPage() {
  if (!(await getSession())) redirect('/login')
  return <TvClient />
}
