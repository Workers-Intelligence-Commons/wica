// Light formatting of a message for the guest chat component: paragraphs, lists, headings, code,
// bold, italic and links. The text becomes a tree that `render` writes with text nodes only, so
// nothing in a message can add markup to the page that holds the component; a link keeps only an
// http or https address.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

export type Block =
  | { t: 'p' | 'h'; c: Inline[] }
  | { t: 'pre'; v: string }
  | { t: 'ul' | 'ol'; items: Inline[][] }

const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\s][^*\n]*)\*|(?<![\w])_([^_\s][^_\n]*)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

/** An http or https address, or `null` for any other. */
export function safeHref(text: string): string | null {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    const [whole, code, strong, label, href, star, under, bare] = m
    if (code !== undefined) out.push({ t: 'code', v: code })
    else if (strong !== undefined) out.push({ t: 'strong', c: inline(strong) })
    else if (label !== undefined && href !== undefined) {
      const safe = safeHref(href)
      out.push(safe ? { t: 'link', href: safe, c: inline(label) } : { t: 'text', v: whole })
    } else if (star !== undefined || under !== undefined) {
      out.push({ t: 'em', c: inline(star ?? under ?? '') })
    } else if (bare !== undefined) {
      const safe = safeHref(bare)
      out.push(
        safe ? { t: 'link', href: safe, c: [{ t: 'text', v: bare }] } : { t: 'text', v: bare },
      )
    }
    last = at + whole.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

const BULLET = /^\s*[-*•]\s+/
const NUMBERED = /^\s*\d+[.)]\s+/
const HEADING = /^#{1,6}\s+/

export function blocks(text: string): Block[] {
  const out: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) out.push({ t: 'p', c: inline(paragraph.join('\n')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trimStart().startsWith('```')) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```'); i++) {
        code.push(lines[i] ?? '')
      }
      out.push({ t: 'pre', v: code.join('\n') })
    } else if (HEADING.test(line)) {
      flush()
      out.push({ t: 'h', c: inline(line.replace(HEADING, '')) })
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      flush()
      const kind = BULLET.test(line) ? 'ul' : 'ol'
      const marker = kind === 'ul' ? BULLET : NUMBERED
      const items: Inline[][] = []
      for (; i < lines.length && marker.test(lines[i] ?? ''); i++) {
        items.push(inline((lines[i] ?? '').replace(marker, '')))
      }
      i--
      out.push({ t: kind, items })
    } else if (line.trim() === '') flush()
    else paragraph.push(line)
  }
  flush()
  return out
}

function renderInline(parts: Inline[], into: Node) {
  for (const part of parts) {
    if (part.t === 'text') into.appendChild(document.createTextNode(part.v))
    else if (part.t === 'code') {
      const el = document.createElement('code')
      el.textContent = part.v
      into.appendChild(el)
    } else if (part.t === 'link') {
      const el = document.createElement('a')
      el.href = part.href
      el.target = '_blank'
      el.rel = 'noopener noreferrer'
      renderInline(part.c, el)
      into.appendChild(el)
    } else {
      const el = document.createElement(part.t)
      renderInline(part.c, el)
      into.appendChild(el)
    }
  }
}

/** Writes the formatted text into `into`, replacing what it held. */
export function render(text: string, into: HTMLElement) {
  into.replaceChildren()
  for (const block of blocks(text)) {
    if (block.t === 'pre') {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = block.v
      pre.appendChild(code)
      into.appendChild(pre)
    } else if (block.t === 'ul' || block.t === 'ol') {
      const list = document.createElement(block.t)
      for (const item of block.items) {
        const li = document.createElement('li')
        renderInline(item, li)
        list.appendChild(li)
      }
      into.appendChild(list)
    } else if (block.t === 'p' || block.t === 'h') {
      // A heading stays a paragraph: the page that holds the component keeps its own outline.
      const el = document.createElement('p')
      if (block.t === 'h') el.className = 'heading'
      renderInline(block.c, el)
      into.appendChild(el)
    }
  }
}
