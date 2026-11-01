// The settings are a dialog over any page: this address opens it over the new conversation, on
// the tool servers after a tool server sign-in, else on the account.

import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: ({ search }) => {
    const toolServer = (search as { toolServer?: unknown }).toolServer
    throw redirect({
      to: '/',
      search:
        typeof toolServer === 'string'
          ? { settings: 'tools', toolServer }
          : { settings: 'account' },
    })
  },
})
