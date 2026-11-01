// What the guest chat component learns from `GET /api/embed`.

/** How the component follows a conversation: the live socket (Workers) or the shapes (Compose). */
export type EmbedInfo = { sync: 'socket' | 'shapes' }
