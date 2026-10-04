export const PAGES = ['ui', 'board', 'market', 'flex', 'escrow'] as const

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })

export function compilePage(name: string, source: string): string {
  return `// Generated from web/src/${name}.ts by scripts/build-web.ts. Edit that file instead.\n` +
    transpiler.transformSync(source)
}
