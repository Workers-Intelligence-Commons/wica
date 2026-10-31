// Graphe des paquets : chaque paquet ne dépend que de ceux de sa liste.
const allowed = {
  core: [],
  codecs: ['core'],
  protocol: ['core'],
  runtime: ['core', 'codecs', 'protocol'],
  'transport-memory': ['protocol'],
  'transport-ws': ['protocol'],
  'transport-stdio': ['protocol'],
  'transport-inbox': ['protocol'],
  'tools-node': ['runtime'],
  'model-compat': ['core', 'codecs', 'runtime'],
  'model-pi': ['core', 'codecs', 'runtime'],
  'tools-user': ['core'],
  mcp: ['core', 'runtime'],
  skills: ['core'],
  client: ['core', 'protocol', 'tools-user'],
  'client-react': ['core', 'protocol', 'tools-user', 'client'],
  acp: ['core', 'protocol', 'tools-user', 'client'],
  'chat-remote': ['core', 'protocol', 'runtime', 'transport-inbox'],
}
const nodeAllowed = ['tools-node', 'transport-inbox', 'transport-ws', 'transport-stdio']
// Dans `mcp` et `acp`, seule l'entrée `./node` dépend de Node : le lancement de serveurs MCP
// locaux, et le flux ACP sur l'entrée et la sortie standard.
const nodeEntries = ['^packages/mcp/src/node\\.ts$', '^packages/acp/src/node\\.ts$']
const alt = (names) => names.map((n) => n.replace(/[-]/g, '\\-')).join('|')

module.exports = {
  forbidden: [
    ...Object.entries(allowed).map(([name, deps]) => ({
      name: `graphe-${name}`,
      severity: 'error',
      from: { path: `^packages/${name}/` },
      to: {
        path: '^packages/([^/]+)/',
        pathNot: [`^packages/(${alt([name, ...deps])})/`],
      },
    })),
    {
      name: 'core-types-seulement',
      severity: 'error',
      from: { path: '^packages/core/src/' },
      to: { dependencyTypesNot: ['type-only', 'local'] },
    },
    {
      name: 'api-web-standard',
      severity: 'error',
      from: { path: '^packages/', pathNot: [`^packages/(${alt(nodeAllowed)})/`, ...nodeEntries] },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'mcp-stdio-dans-node',
      severity: 'error',
      from: { path: '^packages/mcp/', pathNot: nodeEntries },
      to: { path: '@modelcontextprotocol/client/dist/stdio' },
    },
    {
      name: 'paquets-sans-applications',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    // L'arbre des routes généré par TanStack importe le routeur, qui l'importe : ce retour n'est
    // qu'un import de type, que le générateur impose.
    {
      name: 'pas-de-cycle',
      severity: 'error',
      from: {},
      to: { circular: true, viaNot: 'routeTree\\.gen\\.ts$' },
    },
    // Un import non résolu échapperait aux règles du graphe : il est refusé. Les modules
    // `cloudflare:` sont fournis par le moteur de Workers, pas par un fichier.
    {
      name: 'import-resolu',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '^cloudflare:' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    // Les paquets du dépôt exportent leurs sources `.ts` ; sans ces options, leurs imports
    // restent non résolus et les règles du graphe ne voient rien.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
    exclude: { path: '(^|/)(test|dist)/' },
  },
}
