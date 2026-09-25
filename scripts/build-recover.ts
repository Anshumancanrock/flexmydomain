/**
 * Build web/recover.html as one inlined file that works offline from file://.
 * Bundles core/escrow only, so recovery depends on nothing that could be down.
 */

export {} // top-level await needs this file to be a module

const bundle = await Bun.build({
  entrypoints: ['core/escrow/index.ts'],
  target: 'browser',
  format: 'esm',
  minify: false, // readable, so it can be checked before use
})

if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

const escrowJs = await bundle.outputs[0].text()
const shell = await Bun.file('scripts/recover.shell.html').text()

/* A classic <script> can't hold the bundle's `export { ... }`, so strip it.
   type="module" is out because some browsers block modules on file://. */
const inlined = escrowJs.replace(/^export\s*\{[^}]*\};?\s*$/m, '')

const html = shell.replace('/*__ESCROW_BUNDLE__*/', () => inlined)
await Bun.write('web/recover.html', html)

const kb = (html.length / 1024).toFixed(1)
console.log(`web/recover.html  ${kb} KB  (self-contained, no network)`)
