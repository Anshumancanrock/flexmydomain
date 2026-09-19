/**
 * Build the browser bundle: client/index.ts -> web/assets/fmd.js
 *
 * One ES module, every dependency inlined, no CDN. `bun run build`.
 *
 * The pages use no framework; this step only bundles the TypeScript core into
 * one plain `.js` file. The output is committed, so `python3 serve.py` serves
 * the site with nothing installed and nothing to build first.
 */

export {} // top-level await needs this file to be a module

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
