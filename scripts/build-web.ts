/**
 * Build the browser code: client/index.ts -> web/assets/fmd.js, and each page
 * script in web/src/ -> web/assets/<page>.js. `bun run build`.
 *
 * The bundle is one ES module with every dependency inlined and no CDN. The
 * page scripts use no framework. Both outputs are committed, so the site can
 * be served as it is, with nothing installed and nothing to build first.
 */

import { PAGES, compilePage } from './pages.ts'

const result = await Bun.build({
  entrypoints: ['client/index.ts'],
  outdir: 'web/assets',
  naming: 'fmd.js',
  target: 'browser',
  format: 'esm',
  // Not minified, so the code the pages run can be read as it is.
  minify: false,
  sourcemap: 'none',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const output = result.outputs[0]
const bytes = await output.arrayBuffer()
console.log(`web/assets/fmd.js  ${(bytes.byteLength / 1024).toFixed(1)} KB`)

for (const page of PAGES) {
  const js = compilePage(page, await Bun.file(`web/src/${page}.ts`).text())
  await Bun.write(`web/assets/${page}.js`, js)
  console.log(`web/assets/${page}.js  ${(js.length / 1024).toFixed(1)} KB`)
}
