// `<wic-guest-chat>`: a guest chat with the default model of a hub, for the pages of other sites.
// A site the hub allows (WICA_EMBED_ORIGINS) loads this module from the hub and places the
// element where the chat goes:
//
//   <script type="module" src="https://hub.example/embed/wic-guest-chat.js"></script>
//   <wic-guest-chat></wic-guest-chat>
//
// It asks for the consent the hub needs from guests, then holds one conversation at a time.
// "Continue on the hub" opens it on the hub, which takes over the guest key.

import { CONSENT_KINDS, type ConsentId } from '../shared/consent.ts'
import type { EmbedInfo } from '../shared/embed.ts'
import { conversationView } from '../client/view.ts'
import { type HubApi, HubError, hubApi } from './api.ts'
import { render } from './format.ts'
import { declareFonts, styles } from './styles.ts'
import { type Rows, follow } from './sync.ts'

/** The kinds of consent the hub asks of guests. */
const GUEST_CONSENTS = CONSENT_KINDS.filter((kind) =>
  (kind.audience as readonly string[]).includes('guest'),
)

/** The hub that serves this module. */
const HUB = new URL('/', import.meta.url)

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

class WicGuestChat extends HTMLElement {
  readonly #api: HubApi = hubApi(HUB)
  readonly #root = this.attachShadow({ mode: 'open' })
  #info: EmbedInfo | null = null
  #stop: (() => void) | null = null
  #rows: Rows = { items: [], chunks: [] }
  /** A message sent and not yet seen in the rows, after the items up to `seq`. */
  #pending: { text: string; seq: number } | null = null
  #sending = false

  #log = el('div', { className: 'log' })
  #status = el('p', { className: 'status' })
  #field = el('textarea', { placeholder: 'Your message', rows: 2 })
  #send = el('button', { className: 'send', type: 'submit', textContent: 'Send' })
  #form = el('form', {}, [this.#field, this.#send])
  #continue = el('a', { className: 'quiet', textContent: 'Continue on the hub', target: '_blank' })
  #restartButton = el('button', {
    className: 'quiet',
    type: 'button',
    textContent: 'New conversation',
  })

  connectedCallback() {
    if (this.#root.childElementCount > 0) return
    declareFonts()
    this.#log.setAttribute('role', 'log')
    this.#log.setAttribute('aria-live', 'polite')
    this.#status.setAttribute('aria-live', 'polite')
    this.#field.setAttribute('aria-label', 'Your message')
    this.#continue.rel = 'noopener'
    this.#restartButton.onclick = () => this.#restart()
    this.#root.append(
      el('style', { textContent: styles }),
      el('div', { className: 'sheet' }, [
        el('header', {}, [
          el('p', { className: 'title' }, [
            'W',
            el('span', { className: 'title-red', textContent: 'H' }),
            ' hub',
          ]),
          el('span', { className: 'spacer' }),
          this.#restartButton,
          this.#continue,
        ]),
        this.#log,
        this.#status,
        this.#form,
      ]),
    )
    this.#form.onsubmit = (event) => {
      event.preventDefault()
      void this.#submit()
    }
    this.#field.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void this.#submit()
      }
    }
    void this.#open()
  }

  disconnectedCallback() {
    this.#stop?.()
    this.#stop = null
  }

  async #open() {
    this.#ready(false)
    try {
      this.#info = await this.#api.info()
    } catch {
      return this.#notice('This site may not hold the chat of this hub.')
    }
    const kinds = GUEST_CONSENTS
    const unanswered = kinds.find((kind) => !this.#api.consent(kind.id))
    if (unanswered) return this.#askConsent(unanswered)
    if (kinds.some((kind) => !this.#api.consent(kind.id)?.granted)) return this.#declined()
    try {
      await this.#api.start()
    } catch (error) {
      return this.#notice(`The hub could not start a guest session: ${message(error)}`)
    }
    const conversation = this.#api.conversation()
    if (conversation) this.#follow(conversation)
    this.#draw()
    this.#ready(true)
  }

  #askConsent(kind: { id: ConsentId; title: string; text: string }) {
    const agree = el('button', { className: 'agree', type: 'button', textContent: 'Agree' })
    const decline = el('button', { className: 'quiet', type: 'button', textContent: 'Decline' })
    agree.onclick = () => {
      this.#api.answer(kind.id, true)
      void this.#open()
    }
    decline.onclick = () => {
      this.#api.answer(kind.id, false)
      this.#declined()
    }
    this.#log.replaceChildren(
      el('section', { className: 'consent' }, [
        el('h3', { textContent: kind.title }),
        el('p', { textContent: kind.text }),
        el('div', { className: 'actions' }, [agree, decline]),
      ]),
    )
  }

  #declined() {
    this.#ready(false)
    const hub = el('a', {
      href: HUB.href,
      target: '_blank',
      rel: 'noopener',
      textContent: 'the hub',
    })
    this.#log.replaceChildren(
      el('p', { className: 'empty' }, [
        'Without this consent, the hub cannot count your messages, so the chat stays closed. You can still create an account on ',
        hub,
        '.',
      ]),
    )
  }

  #notice(text: string) {
    this.#ready(false)
    this.#log.replaceChildren(el('p', { className: 'empty', textContent: text }))
  }

  #ready(on: boolean) {
    this.#field.disabled = !on
    this.#send.disabled = !on || this.#sending
    this.#continue.href = this.#api.continueUrl()
    this.#continue.hidden = !on
    this.#restartButton.hidden = !on
  }

  #follow(conversationId: string) {
    this.#stop?.()
    this.#rows = { items: [], chunks: [] }
    this.#stop = follow(this.#api, this.#info?.sync ?? 'socket', conversationId, {
      rows: (rows) => {
        this.#rows = rows
        this.#draw()
      },
      failed: (error) => {
        // The conversation was erased, or its key was handed over to the hub: start afresh, with
        // a new key in the second case.
        this.#api.setConversation(undefined)
        this.#stop = null
        this.#rows = { items: [], chunks: [] }
        if (error instanceof HubError && error.status === 401) {
          this.#api.forget()
          void this.#open()
        } else this.#draw()
      },
    })
  }

  #restart() {
    this.#stop?.()
    this.#stop = null
    this.#api.setConversation(undefined)
    this.#rows = { items: [], chunks: [] }
    this.#pending = null
    this.#status.textContent = ''
    this.#draw()
    this.#ready(Boolean(this.#api.key()))
    this.#field.focus()
  }

  /** The last item of the conversation: with no branch to choose, the one written last. */
  #head() {
    let last: { id: string; seq: number } | null = null
    for (const row of this.#rows.items) if (!last || row.seq > last.seq) last = row
    return last
  }

  async #submit() {
    const text = this.#field.value.trim()
    if (!text || this.#sending || this.#field.disabled) return
    this.#sending = true
    this.#ready(true)
    this.#status.textContent = ''
    try {
      await this.#deliver(text).catch(async (error: unknown) => {
        // A key handed over to the hub meanwhile is no longer known: a new one sends it again.
        if (!(error instanceof HubError && error.status === 401)) throw error
        this.#stop?.()
        this.#stop = null
        this.#rows = { items: [], chunks: [] }
        this.#api.forget()
        await this.#api.start()
        await this.#deliver(text)
      })
      this.#field.value = ''
    } catch (error) {
      this.#pending = null
      this.#status.replaceChildren(el('span', { className: 'alert', textContent: message(error) }))
      this.#draw()
    } finally {
      this.#sending = false
      this.#ready(true)
    }
  }

  /** Sends `text` in the current conversation, created first when there is none. */
  async #deliver(text: string) {
    let conversation = this.#api.conversation()
    if (!conversation) {
      conversation = (await this.#api.createConversation()).id
      this.#api.setConversation(conversation)
      this.#follow(conversation)
    }
    const head = this.#head()
    this.#pending = { text, seq: head?.seq ?? -1 }
    this.#draw()
    await this.#api.send(conversation, head?.id ?? null, text)
  }

  #draw() {
    const head = this.#head()
    const view = conversationView(this.#rows.items, this.#rows.chunks, head?.id ?? null)
    if (
      this.#pending &&
      view.items.some((i) => i.kind === 'user_message' && i.seq > (this.#pending?.seq ?? 0))
    ) {
      this.#pending = null
    }
    const nodes: Node[] = []
    for (const entry of view.entries) {
      if (entry.type === 'user') {
        const text = entry.item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
        nodes.push(this.#user(text, false))
      } else if (entry.type === 'assistant' || entry.type === 'say') {
        const box = el('div', { className: 'message' })
        render(entry.text, box)
        nodes.push(box)
      } else if (entry.type === 'failure') {
        nodes.push(el('div', { className: 'message failure', textContent: entry.message }))
      }
    }
    if (this.#pending) nodes.push(this.#user(this.#pending.text, true))
    if (nodes.length === 0 && this.#api.key()) {
      nodes.push(
        el('p', { className: 'empty', textContent: 'Ask the model anything to try the hub.' }),
      )
    }
    if (nodes.length > 0 || this.#api.key()) this.#log.replaceChildren(...nodes)
    const writing = this.#pending !== null || view.running === true || !view.settled
    if (!this.#status.querySelector('.alert')) {
      this.#status.textContent =
        writing && this.#rows.items.length > 0 ? 'The model is writing…' : ''
    }
    this.#log.scrollTop = this.#log.scrollHeight
    this.#continue.href = this.#api.continueUrl()
  }

  #user(text: string, pending: boolean) {
    const box = el('div', { className: `message user${pending ? ' pending' : ''}` }, [
      el('span', { className: 'who', textContent: 'you' }),
    ])
    const body = el('div')
    render(text, body)
    box.append(...body.childNodes)
    return box
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

if (!customElements.get('wic-guest-chat')) customElements.define('wic-guest-chat', WicGuestChat)
