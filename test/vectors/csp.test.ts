// Each page's CSP must hash exactly its inline scripts. Browsers skip a missed one silently.
import { test, expect } from 'bun:test'
import { inlineScriptHashes } from '../../scripts/csp.ts'

const web = new URL('../../web/', import.meta.url)

for (const page of ['index', 'market', 'flex', 'escrow', 'recover']) {
  test(`web/${page}.html allows its inline scripts and nothing else inline`, async () => {
    const html = await Bun.file(new URL(`${page}.html`, web)).text()
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)
    expect(meta).not.toBeNull()
    // A policy only covers what comes after it.
    expect(meta!.index!).toBeLessThan(html.indexOf('<script'))

    const scriptSrc = meta![1]!.split(';').map((d) => d.trim().split(/\s+/))
      .find(([name]) => name === 'script-src')
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    const listed = scriptSrc!.filter((s) => s.startsWith("'sha256-")).sort()
    expect(listed).toEqual([...new Set(await inlineScriptHashes(html))].sort())
  })
}

test('recover.html can make no network requests', async () => {
  const html = await Bun.file(new URL('recover.html', web)).text()
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1]!
  expect(policy.split(';').map((d) => d.trim())).toContain("default-src 'none'")
  expect(policy).not.toMatch(/connect-src|img-src|font-src/)
})
