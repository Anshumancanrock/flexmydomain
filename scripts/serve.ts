/**
 * Serve web/ for local development: `bun run serve`, or `bun run serve -p 3000`.
 *
 * Nothing is cached, so an edited file shows on the next reload. Only
 * 127.0.0.1 is bound; this is not a production server.
 */
import { join, normalize } from 'node:path'

const root = join(import.meta.dir, '..', 'web')
const flag = process.argv.findIndex((a) => a === '-p' || a === '--port')
const port = flag === -1 ? 8000 : Number(process.argv[flag + 1])

const headers = { 'cache-control': 'no-store' }

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    let path: string
    try {
      // normalize() on an absolute path cannot climb above it, so the result
      // always stays inside web/.
      path = normalize(decodeURIComponent(new URL(request.url).pathname))
    } catch {
      return new Response('bad request', { status: 400, headers })
    }
    for (const candidate of [join(root, path), join(root, path, 'index.html')]) {
      const file = Bun.file(candidate)
      if (await file.exists()) return new Response(file, { headers })
    }
    console.log(`${path} -> 404`)
    return new Response('not found', { status: 404, headers })
  },
})

console.log(`flexmydomain -> http://localhost:${port}`)
