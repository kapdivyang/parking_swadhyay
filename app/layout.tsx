import type { Metadata, Viewport } from 'next'
import './globals.css'
import ServiceWorkerRegister from './sw-register'

export const metadata: Metadata = {
  title: 'Event Parking',
  description: 'Vehicle parking entry and search system',
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0f172a',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Deliberately no dark mode — outdoors in bright sunlight, only a fixed
    // light theme with high contrast stays readable
    <html lang="en" className="h-full">
      <body className="min-h-full bg-slate-100 text-slate-900 antialiased">
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  )
}
