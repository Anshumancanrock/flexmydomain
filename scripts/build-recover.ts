/**
 * Build web/recover.html: one self-contained file, no network, no CDN.
 *
 * The page must work when opened from file:// on a machine with no internet
 * and nothing else from this project installed. That rules out a module
 * import, a stylesheet link and a font, so everything is inlined into a
 * single document.
 *
 * The bundle is built from core/escrow only, with no relays, DNS, RDAP or
 * config, so the recovery path depends on nothing that could be down.
 */

export {} // top-level await needs this file to be a module

const bundle = await Bun.build({
  entrypoints: ['core/escrow/index.ts'],
  target: 'browser',
  format: 'esm',
  minify: false, // readable, so the inlined code can be checked before use
})

if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

const escrowJs = await bundle.outputs[0].text()
const shell = await Bun.file('scripts/recover.shell.html').text()

/* The bundle is an ES module ending in `export { ... }`, which a classic
   <script> cannot contain. Strip the export statement and let the declarations
   sit in the script's own scope. A type="module" script is not an option:
   some browsers block modules on file://, which is where this page runs. */
const inlined = escrowJs.replace(/^export\s*\{[^}]*\};?\s*$/m, '')

const html = shell.replace('/*__ESCROW_BUNDLE__*/', () => inlined)
await Bun.write('web/recover.html', html)

const kb = (html.length / 1024).toFixed(1)
console.log(`web/recover.html  ${kb} KB  (self-contained, no network)`)
