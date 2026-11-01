// Build target, set by `vite.config.ts` from `WICA_TARGET`: it chooses the browser sync source.
interface ImportMetaEnv {
  readonly WICA_TARGET: 'node' | 'workers'
}
