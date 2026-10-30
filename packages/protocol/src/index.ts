// Protocole client : le client lit un flux reprenable
// d'éléments et envoie des commandes, et le serveur répond.

import type { Item, Part } from '@wica/core'

export const PROTOCOL_VERSION = 1

export type Command =
  | { t: 'send'; parentId: string | null; parts: Part[] }
  | { t: 'answer'; callId: string; value: unknown }
  | { t: 'interrupt' }
  | { t: 'set_head'; itemId: string }
  | { t: 'regenerate'; itemId: string }

/**
 * Valeur d'`answer` pour un outil de l'environnement exécuté par le client (fichiers ou terminal
 * d'un éditeur) : le résultat tel quel, qui reste un résultat d'outil et jamais la parole de la
 * personne.
 */
export type ClientToolResult = { output: Part[]; isError?: boolean }

/** `commandId` : rejeu sans doublon ; `clientSeq` : ordre des commandes d'un client. */
export type Envelope = {
  kind: 'command'
  sessionId: string
  commandId: string
  clientSeq: number
  conversationId: string
  command: Command
}

/** Lecture reprenable : tout élément dont le `seq` dépasse `fromSeq`, puis le flux en direct. */
export type Subscribe = { kind: 'subscribe'; conversationId: string; fromSeq: number }

export type ClientFrame =
  /** `sessionId` : session à reprendre, sans nouvelle authentification si elle est encore valide. */
  | { kind: 'hello'; version: number; token?: string; sessionId?: string }
  | Subscribe
  | { kind: 'unsubscribe'; conversationId: string }
  /** Battement de cœur : le serveur répond `pong`, ce qui révèle une connexion morte. */
  | { kind: 'ping' }
  | Envelope

export type ServerFrame =
  /** `resumed` : la session demandée a été reprise ; sinon une nouvelle a été ouverte. */
  | { kind: 'welcome'; version: number; sessionId: string; resumed: boolean }
  | { kind: 'items'; conversationId: string; salt: string; items: Item[] }
  | { kind: 'head'; conversationId: string; itemId: string }
  | { kind: 'delta'; conversationId: string; itemId: string; text: string }
  | { kind: 'progress'; conversationId: string; callId: string; message: string }
  | { kind: 'ack'; commandId: string; ok: true }
  | { kind: 'ack'; commandId: string; ok: false; error: string }
  | { kind: 'error'; message: string; conversationId?: string }
  | { kind: 'pong' }
  /** Un tour tourne pour cette conversation, ou plus aucun. */
  | { kind: 'status'; conversationId: string; running: boolean }

export type Frame = ClientFrame | ServerFrame

/**
 * Canal de trames entre un client et un serveur. Livraison au moins une fois, sans garantie
 * d'ordre entre deux connexions : le protocole tient le reste (identifiants, curseurs).
 */
export interface Transport<Out extends Frame = Frame, In extends Frame = Frame> {
  send(frame: Out): Promise<void>
  receive(): AsyncIterable<In>
  close(): Promise<void>
}

export interface ClientTransport extends Transport<ClientFrame, ServerFrame> {
  /**
   * Transport qui se reconnecte seul : `listener` est appelé après chaque reconnexion, pour que
   * le client reprenne (hello, abonnements depuis son curseur, commandes sans accusé).
   */
  onReopen?(listener: () => void): () => void
}
export type ServerTransport = Transport<ServerFrame, ClientFrame>
