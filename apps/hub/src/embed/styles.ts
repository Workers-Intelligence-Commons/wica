// Look of the guest chat component: the hub's colors and type, from the design system tokens.
// Inside the component, the tokens apply to the component's root instead of the page's. A font
// declared inside a component is ignored by browsers, so the three fonts it uses are declared on
// the page that holds it, once, from the files of the hub.

import tokens from '@workers-intelligence-commons/tokens/tokens.css?raw'
import caslonItalic from '@workers-intelligence-commons/tokens/fonts/LibreCaslonText-Italic.woff2?url'
import caslon from '@workers-intelligence-commons/tokens/fonts/LibreCaslonText-Regular.woff2?url'
import franklinBold from '@workers-intelligence-commons/tokens/fonts/LibreFranklin-Bold.woff2?url'

const FONTS_ID = 'wic-guest-chat-fonts'

/** Declares the fonts on the page, once for every component it holds. */
export function declareFonts() {
  if (document.getElementById(FONTS_ID)) return
  const face = (family: string, url: string, weight: number, style = 'normal') =>
    `@font-face { font-family: '${family}'; src: url('${new URL(url, import.meta.url).href}') format('woff2'); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`
  const style = document.createElement('style')
  style.id = FONTS_ID
  style.textContent = [
    face('Libre Franklin', franklinBold, 700),
    face('Libre Caslon Text', caslon, 400),
    face('Libre Caslon Text', caslonItalic, 400, 'italic'),
  ].join('\n')
  document.head.appendChild(style)
}

/** The tokens without their fonts, on the component's root; the page's theme choice stays its own. */
const hostTokens = tokens
  .replace(/@font-face\s*\{[^}]*\}/g, '')
  .replace(/:root\[data-theme="dark"\]\s*\{[^}]*\}/g, '')
  .replace(/:root:not\(\[data-theme="light"\]\)/g, ':host')
  .replace(/:root/g, ':host')

export const styles = `${hostTokens}
:host {
  display: block;
  height: 520px;
  max-width: 720px;
  color: var(--ink);
  font-family: var(--font-serif);
  font-size: 17px;
  line-height: 1.55;
}
* { box-sizing: border-box; }
.sheet {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--paper-raised);
  border: 1px solid var(--line);
}
header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line);
}
.title { margin: 0; font-family: var(--font-gothic); font-weight: 700; font-size: 16px; }
.title-red { color: var(--red); }
.spacer { flex: 1; }
.quiet {
  padding: 2px 0;
  border: 0;
  border-bottom: 3px solid var(--ochre);
  background: none;
  color: var(--ink);
  font: 700 14px var(--font-gothic);
  text-decoration: none;
  cursor: pointer;
}
.quiet:hover { border-bottom-color: var(--red); }
.log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.empty { margin: auto 0; color: var(--ink-muted); font-style: italic; text-align: center; }
.message { max-width: 100%; overflow-wrap: anywhere; }
.message > :first-child { margin-top: 0; }
.message > :last-child { margin-bottom: 0; }
.message p, .message ul, .message ol, .message pre { margin: 0 0 var(--space-2); }
.message ul, .message ol { padding-left: var(--space-6); }
.message .heading { font-family: var(--font-gothic); font-weight: 700; }
.message code { font-family: var(--font-typewriter); font-size: 0.92em; }
.message pre {
  padding: var(--space-2) var(--space-3);
  overflow-x: auto;
  background: var(--paper);
  border: 1px solid var(--line);
}
.message a { color: var(--red-ink); }
.user {
  align-self: flex-end;
  max-width: 85%;
  padding: var(--space-2) var(--space-3);
  background: var(--paper);
  border: 1px solid var(--line);
}
.user.pending { opacity: 0.6; }
.who { display: block; color: var(--ink-muted); font-style: italic; font-size: 14px; }
.failure { padding-left: var(--space-3); border-left: 4px solid var(--red); color: var(--red-ink); }
.status { min-height: 1.4em; margin: 0; padding: 0 var(--space-4); color: var(--ink-muted); font-style: italic; font-size: 14px; }
.alert { color: var(--red-ink); font-style: normal; font-family: var(--font-gothic); font-weight: 700; }
form {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
textarea {
  flex: 1;
  min-height: 46px;
  max-height: 160px;
  padding: var(--space-2) var(--space-3);
  resize: vertical;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  font: inherit;
}
textarea:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--ochre); outline-offset: 2px; }
.send {
  align-self: flex-end;
  height: 46px;
  padding: 0 var(--space-6);
  border: 0;
  background: var(--ink);
  color: var(--paper);
  font: 700 16px var(--font-gothic);
  clip-path: polygon(1% 4%, 50% 0, 99% 5%, 100% 96%, 50% 100%, 0 95%);
  cursor: pointer;
}
.send:disabled { opacity: 0.45; cursor: default; }
.consent { margin: auto 0; padding: var(--space-4); border-left: 4px solid var(--ochre); }
.consent h3 { margin: 0 0 var(--space-2); font: 700 16px var(--font-gothic); }
.consent p { margin: 0 0 var(--space-3); }
.actions { display: flex; gap: var(--space-4); align-items: center; }
.agree {
  height: 40px;
  padding: 0 var(--space-4);
  border: 0;
  background: var(--red);
  color: var(--on-red);
  font: 700 15px var(--font-gothic);
  clip-path: polygon(1% 4%, 50% 0, 99% 5%, 100% 96%, 50% 100%, 0 95%);
  cursor: pointer;
}
@media (prefers-reduced-motion: no-preference) {
  .sheet { animation: paste var(--motion-sheet) var(--ease-paste) both; }
  @keyframes paste { from { opacity: 0; transform: translateY(6px); } }
}
`
