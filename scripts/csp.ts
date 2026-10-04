// A page's CSP must list the hash of each inline script, or the browser won't run it.
import { createHash } from 'node:crypto'

/** CSP source expressions for the page's inline scripts, in page order. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = []
  let text: string | undefined
  await new HTMLRewriter()
    .on('script', {
      element(el) {
        if (el.hasAttribute('src')) return
        text = ''
        el.onEndTag(() => {
          hashes.push(`'sha256-${createHash('sha256').update(text!).digest('base64')}'`)
          text = undefined
        })
      },
      text(chunk) {
        if (text !== undefined) text += chunk.text
      },
    })
    .transform(new Response(html))
    .text()
  return hashes
}
