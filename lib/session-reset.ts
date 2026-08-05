'use client'

/**
 * Wipe everything the browser is holding on behalf of the previous user,
 * then hard-navigate.
 *
 * Signing in or out changes who every page belongs to, and two separate
 * caches will happily disagree about that:
 *
 *   - Next.js keeps rendered pages in its client router cache, so a
 *     `router.push('/')` after login can paint the *previous* account's
 *     home screen, tiles and all, before anything refetches.
 *   - The service worker stores each navigation's HTML, and that HTML now
 *     names the signed-in person and lists what they may do.
 *
 * Neither is a way past the server — every API call is still checked, so
 * the stale screen's buttons simply fail. But a block admin being shown
 * the Super Admin's screen is alarming and unexplainable, and on a shared
 * phone it is one person seeing another's.
 *
 * A full page load is the fix for the first, and cannot be got wrong the
 * way `push` + `refresh` can. Clearing the caches is the fix for the
 * second.
 */
export async function resetAndGo(destination: string) {
  try {
    if ('serviceWorker' in navigator) {
      // Ask the worker to empty its caches, and wait for it to say it has.
      // Best effort with a short deadline: a hung worker must not leave
      // somebody stuck on the login screen.
      const reg = await navigator.serviceWorker.getRegistration()
      const worker = reg?.active
      if (worker) {
        await Promise.race([
          new Promise<void>((resolve) => {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => resolve()
            worker.postMessage({ type: 'CLEAR_CACHE' }, [channel.port2])
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ])
      }
    }
  } catch {
    // An unavailable service worker is not a reason to block signing in;
    // the hard navigation below still gets fresh HTML from the server.
  }

  // Not router.push — a full load, so nothing rendered for the previous
  // account survives into this one.
  window.location.href = destination
}
