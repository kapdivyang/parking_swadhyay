import Link from 'next/link'

// Shown only when the network is down and the requested page was never cached.
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-8 text-center">
      <div className="text-5xl">📶</div>
      <h1 className="mt-4 text-2xl font-bold">No network right now</h1>
      <p className="mt-2 max-w-xs text-slate-500">
        Vehicle entry still works offline — everything you type is saved on this phone and uploads
        automatically once the network returns.
      </p>
      <Link
        href="/entry"
        className="mt-8 rounded-2xl bg-blue-600 px-8 py-4 text-lg font-bold text-white"
      >
        Go to Vehicle Entry
      </Link>
    </main>
  )
}
