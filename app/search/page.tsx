import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import SearchClient from './search-client'

export default async function SearchPage() {
  if (!(await getSession())) redirect('/login')
  return <SearchClient />
}
