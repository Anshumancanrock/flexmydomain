/**
 * Local dev server for web/: `bun run serve [-p 3000]`. No caching, so edits
 * show on reload. Binds 127.0.0.1 only. Not for production.
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
      // normalize() can't climb above an absolute path, so this stays inside web/.
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
