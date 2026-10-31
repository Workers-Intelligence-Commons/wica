// Remote server of the chat: the Harness of this machine, with its tools, follows the chat's
// command inbox through an outgoing connection and writes its items through the chat API.
// Nothing enters this machine; the chat has already checked each command and the access to its
// conversation.

import { httpStore, chatInbox, whoami, type RemoteOptions } from '@wica/chat-remote'
import { type ClientAuth, type Harness, resilientStore } from '@wica/runtime'
import { inboxTransport } from '@wica/transport-inbox'

import { createLocalServer, type LocalConfig } from './server.ts'

/** Browser messages are signed by the owner account: same origin, same identifier. */
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
