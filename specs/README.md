# Wica : Workers' Intelligence Commons Apps

Wica est le grand monorepo des applications de Workers' Intelligence Commons. Il contient des paquets modulaires (logique partagée ou destinée à être publiée, dont le Harness) et, par-dessus, les applications ; la première est le chat, une interface construite sur le Harness. Les spécifications sont réparties en deux pages : celle du chat s'appuie sur celle du Harness, et le commun n'est écrit qu'une fois, côté Harness.

## Principes du monorepo

- Petits paquets modulaires : un rôle par paquet, les dépendances pointent vers le cœur.
- Deux familles de dossiers : `packages/` pour la logique partagée ou destinée à être publiée, `apps/` pour les applications. Les applications dépendent des paquets, jamais l'inverse.
- Frontière : le Harness définit des interfaces et leur contrat, et une application fournit les implémentations qui touchent son infrastructure (base, synchronisation, identité). Le Harness ne nomme aucune de ces technologies ; la frontière est écrite dans les specs du Harness.
- Licence : tout le code du monorepo est sous AGPL-3.0-or-later.
- Dépendances : leur licence doit être compatible avec l'AGPL-3.0-or-later (voir Licences), contrôlée automatiquement.
- Auto-hébergeable : aucune application ne dépend d'un service externe obligatoire.
- TypeScript, API web standard partout, sauf dans les paquets qui touchent le système.
- Outillage : les espaces de travail de Bun installent et relient les paquets ; Vite+ (`vp`) compile, teste, vérifie et lance les tâches du dépôt. Le code tourne sous Node et sous Cloudflare Workers, pas sous Bun.
- Frontières entre dossiers, licences et conformité des adaptateurs vérifiées en CI (suites de conformité partagées dans le paquet `testing`).

## Licences

Tout le code de Wica est publié sous AGPL-3.0-or-later (AGPL 3.0 ou toute version ultérieure). Les dépendances doivent suivre : une bibliothèque sous licence permissive peut être utilisée dans un projet AGPL, l'inverse n'est pas vrai.

| Licence d'une dépendance | Statut | Remarque |
| --- | --- | --- |
| MIT, BSD, ISC, Unlicense | Acceptée | Compatibles avec l'AGPL 3.0 |
| Apache-2.0 | Acceptée | Compatible avec la famille GPL 3, incompatible avec la GPL 2 seule |
| MPL-2.0 | Acceptée avec précaution | Les fichiers sous MPL restent sous MPL : les garder séparés |
| LGPL-3.0, GPL-3.0-or-later, AGPL-3.0-or-later | Acceptée | Copyleft compatible, la GPL 3 se combine avec l'AGPL 3 |
| GPL-2.0-only | Refusée | Incompatible avec la famille GPL 3 |
| FSL, BSL, SSPL, licences non commerciales ou à restriction d'usage | Refusée | Source disponible mais non libre |
| Propriétaire | Refusée |  |

Règles :

- Ce tableau est une proposition à valider, pas un avis juridique ; à faire relire avant la première publication.
- Les composants lancés comme services séparés (Postgres, Electric, Better Auth, Ory Polis) ne sont pas liés au code de Wica ; par cohérence avec l'auto-hébergement, la même exigence de licence libre s'applique (hypothèse).
- Un outil de contrôle des licences tourne en CI et bloque l'ajout d'une dépendance hors de la liste (outil à choisir).
- Chaque paquet déclare sa licence (champ `license` du `package.json` et fichier LICENSE).
- Le contrôle porte sur les dépendances de production, celles qui sont livrées avec les paquets. Les outils de développement, jamais livrés avec le code de Wica, n'y sont pas soumis (décision du projet).

Source consultée : [tableau de compatibilité de FOSSA](https://fossa.com/resources/devops-tools/license-compatibility-checker/) (outil tiers).

## Carte du monorepo

| Dossier | Rôle | Spécification |
| --- | --- | --- |
| `packages/` | Logique partagée ou destinée à être publiée, en petits modules. Aujourd'hui : le Harness (`core`, `codecs`, `protocol`, `runtime`, `transport-memory`, `transport-stdio`, `transport-ws`, `transport-inbox`, `tools-node`, `tools-user`, `model-compat`, `model-pi`, `mcp`, `skills`, `client`, `client-react`, `testing`) | [Specs du Harness](harness.md) |
| `apps/` | Applications. Aujourd'hui : `apps/local`, le binaire local autonome (commande `wica` : serveur du Harness et client en ligne de commande, par stdio ou WebSocket, et agent ACP pour les éditeurs avec `wica acp`) ; `apps/chat`, l'interface de chat (application TanStack Start, implémentation Postgres du `Store`, synchro Electric, identité, rendu et déploiement) | [Specs du chat : application construite sur le Harness](chat.md) |

Règles :

- Le format du journal, le protocole client, les outils, l'autorisation, les tours sans état et la connexion à MCP sont définis dans les specs du Harness. Le chat n'en décrit que l'usage et la correspondance avec sa base de données.
- Hypothèse : le bloc d'identité (comptes, organisations, clés d'API, adaptateurs), aujourd'hui dans les specs du chat, devient un paquet de `packages/` si une deuxième application rejoint le monorepo.

## État

Le Harness est écrit (les paquets de `packages/`) avec le binaire local `apps/local`. `apps/chat` n'est pas encore écrit. Les points ouverts sont listés à la fin de chaque page de specs.

## Sous-pages

- [Specs du chat : application construite sur le Harness](chat.md)

- [Specs du Harness](harness.md)
