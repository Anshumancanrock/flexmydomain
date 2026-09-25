/**
 * The committed page scripts must be exactly what their TypeScript sources
 * compile to. The site is served as it is, so a stale web/assets/<page>.js
 * would ship.
 */
import { test, expect } from 'bun:test'
import { PAGES, compilePage } from '../../scripts/pages.ts'

const root = new URL('../../', import.meta.url)

for (const page of PAGES) {
  test(`web/assets/${page}.js is built from web/src/${page}.ts`, async () => {
    const source = await Bun.file(new URL(`web/src/${page}.ts`, root)).text()
    const built = await Bun.file(new URL(`web/assets/${page}.js`, root)).text()
    expect(built).toBe(compilePage(page, source))
  })
}
