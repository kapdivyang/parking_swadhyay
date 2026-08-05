import { createClient } from '@supabase/supabase-js'

// Server-side client. It uses the secret key and therefore bypasses RLS.
// NEVER import this file from a client component.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY

if (!url || !secret) {
  throw new Error(
    'Supabase env missing. Set NEXT_PUBLIC_SUPABASE_URL and ' +
      'SUPABASE_SECRET_KEY in .env.local'
  )
}

export const supabaseAdmin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
})
