// Check of the production licenses of each package against the `allowed` list below.
// license-checker does not follow the workspaces from the root: it runs per package.
// `license-clarifications.json` gives the license of a package that does not declare it, checked
// by the hash of its license file.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const allowed = [
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'Unlicense',
  'Apache-2.0',
  'MPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'GPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'OFL-1.1',
  'LicenseRef-WIC-Logos',
]
const bin = join('node_modules', '.bin', 'license-checker-rseidelsohn')
let failed = false
for (const family of ['packages', 'apps']) {
  if (!existsSync(family)) continue
  for (const name of readdirSync(family)) {
    const dir = join(family, name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const deps = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {})
    if (deps.every((d) => d.startsWith('@wica/'))) continue
    try {
      execFileSync(
        bin,
        [
          '--start',
          dir,
          '--production',
          '--excludePrivatePackages',
          '--clarificationsFile',
          join('scripts', 'license-clarifications.json'),
          '--onlyAllow',
          allowed.join(';'),
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      )
      console.log(`licenses compliant: ${dir}`)
    } catch {
      console.error(`license refused in ${dir}`)
      failed = true
    }
  }
}
process.exit(failed ? 1 : 0)
