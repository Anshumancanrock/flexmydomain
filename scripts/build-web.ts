import { PAGES, compilePage } from './pages.ts'

const result = await Bun.build({
  entrypoints: ['client/index.ts'],
  outdir: 'web/assets',
  naming: 'fmd.js',
  target: 'browser',
  format: 'esm',
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
