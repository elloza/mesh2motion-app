/**
 * URL of a file from static/ (served at the root of the site).
 *
 * When the site is built for a sub path, e.g. GitHub Pages at /<repository>/
 * with `vite build --base=/<repository>/`, the files live under that path.
 * With the default relative base ('./') the URL stays root absolute, exactly as
 * before, so the main deployment does not change.
 */
export function public_asset_url (path: string): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
  const base = env?.BASE_URL ?? '/'
  const clean_path = path.replace(/^\/+/, '')
  return base.startsWith('/') ? `${base.endsWith('/') ? base : base + '/'}${clean_path}` : `/${clean_path}`
}
