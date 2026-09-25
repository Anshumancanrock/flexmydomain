/**
 * The page scripts: web/src/<page>.ts compiles to web/assets/<page>.js.
 *
 * Each file is transpiled on its own rather than bundled, so the output keeps
 * its imports of ./fmd.js, ./ui.js and ./config.js as the source wrote them.
 * config.js stays hand-written JavaScript, so an operator can edit it without
 * a build.
 */
export const PAGES = ['ui', 'board', 'market', 'flex', 'escrow'] as const

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })

export function compilePage(name: string, source: string): string {
  return `// Generated from web/src/${name}.ts by scripts/build-web.ts. Edit that file instead.\n` +
    transpiler.transformSync(source)
}
