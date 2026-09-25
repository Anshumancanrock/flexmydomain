/**
 * web/src/<page>.ts -> web/assets/<page>.js. Transpiled one by one, not bundled,
 * so imports of ./fmd.js, ./ui.js and ./config.js stay as written. config.js is
 * hand-written so operators can edit it without a build.
 */
export const PAGES = ['ui', 'board', 'market', 'flex', 'escrow'] as const

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })

export function compilePage(name: string, source: string): string {
  return `// Generated from web/src/${name}.ts by scripts/build-web.ts. Edit that file instead.\n` +
    transpiler.transformSync(source)
}
