// Serveur distant du chat : le Harness de cette machine, avec ses outils, suit la boîte de
// commandes du chat par une connexion sortante et écrit ses éléments par l'API du chat. Rien
// n'entre sur cette machine ; le chat a déjà vérifié chaque commande et l'accès à sa conversation.

import { httpStore, chatInbox, whoami, type RemoteOptions } from '@wica/chat-remote'
import { type ClientAuth, type Harness, resilientStore } from '@wica/runtime'
import { inboxTransport } from '@wica/transport-inbox'

import { createLocalServer, type LocalConfig } from './server.ts'

/** Les messages du navigateur sont signés du compte propriétaire : même origine, même identifiant. */
export function remoteAuth(ownerId: string): ClientAuth {
  return {
    authenticate: async () => ({
      identity: ownerId,
      from: { channel: 'web', author: ownerId, trust: 'owner' },
    }),
    canAccess: async () => true,
  }
}

export async function serveRemote(
  config: Omit<LocalConfig, 'auth'>,
  remote: RemoteOptions,
  onRefused: (message: string) => void,
): Promise<{ harness: Harness; serverId: string; done: Promise<void> }> {
  const me = await whoami(remote)
  const harness = createLocalServer(
    { ...config, auth: remoteAuth(me.ownerId) },
    { store: resilientStore(httpStore(remote)) },
  )
  const done = harness.serve(inboxTransport(chatInbox(remote), { token: remote.token, onRefused }))
  return { harness, serverId: me.serverId, done }
}
