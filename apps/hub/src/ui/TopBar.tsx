// The bar at the top of each logged-in page: the button that opens the conversations, what the
// page is about, and a new conversation. The drawer it opens belongs to the layout.

import { Link } from '@tanstack/react-router'
import { Button } from '@workers-intelligence-commons/components'
import { createContext, type ReactNode, useContext } from 'react'

/** Opens the drawer of the conversations; given by the layout. */
export const DrawerContext = createContext<() => void>(() => {})

export function TopBar({ children }: { children?: ReactNode }) {
  const openDrawer = useContext(DrawerContext)
  return (
    <header className="topbar">
      <Button variant="quiet" onClick={openDrawer}>
        Conversations
      </Button>
      <div className="topbar-title">{children}</div>
      <Link to="/" className="wic-btn wic-focus wic-btn-quiet">
        New conversation
      </Link>
    </header>
  )
}
