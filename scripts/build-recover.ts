import { inlineScriptHashes } from './csp.ts'

const bundle = await Bun.build({
  entrypoints: ['core/escrow/index.ts'],
  target: 'browser',
  format: 'esm',
  minify: false,
})

if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

const escrowJs = await bundle.outputs[0].text()
const shell = await Bun.file('scripts/recover.shell.html').text()

const inlined = escrowJs.replace(/^export\s*\{[^}]*\};?\s*$/m, '')

const page = shell.replace('/*__ESCROW_BUNDLE__*/', () => inlined)

// The CSP allows only these scripts and no network at all.
const hashes = (await inlineScriptHashes(page)).join(' ')
const html = page.replace('__SCRIPT_HASHES__', () => hashes)
await Bun.write('web/recover.html', html)

const kb = (html.length / 1024).toFixed(1)
console.log(`web/recover.html  ${kb} KB  (self-contained, no network)`)
