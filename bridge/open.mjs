import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'

/**
 * The `open_link` tool — a web address opened in the user's own browser.
 *
 * The full browser hands (chrome.mjs) reach Chrome through the Claude
 * extension's native host, which this project only knows how to find on macOS
 * and Linux. This is the small, portable half of that: hand a URL to the
 * operating system and let the default browser open it, signed in as the user.
 * It cannot read, click or type; it only opens.
 *
 * Opening a link in a logged-in browser is still an action — a crafted URL can
 * fire a request as the user — so every call is put in front of the user on
 * screen first, the same native dialog Huginn changes use. The model cannot
 * answer it, which is what stops a link planted in a web page or an email from
 * being opened unseen. Only http(s), no credentials in the URL.
 */

const MAX_URL = 2048

function vet(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (url.href.length > MAX_URL) return null
  return url.href
}

/**
 * The OS opener, given the URL as one argument and no shell. On Windows that
 * rules out `cmd /c start`, whose parser treats & and ^ in a URL as syntax;
 * rundll32's FileProtocolHandler takes the string as-is.
 */
function opener(href) {
  if (process.platform === 'win32') {
    return ['rundll32.exe', ['url.dll,FileProtocolHandler', href]]
  }
  if (process.platform === 'darwin') return ['open', [href]]
  return ['xdg-open', [href]]
}

export function openServer(ask) {
  return createSdkMcpServer({
    name: 'jarvis_open',
    version: '1.0.0',
    instructions:
      "Opens a web page in the user's own browser on this computer, signed in " +
      'as them. Use it when they ask you to open, go to or pull up a site.',
    alwaysLoad: true,
    tools: [
      tool(
        'open_link',
        'Open a web address in a new tab of the user\'s normal browser on this ' +
          'computer. Give a full https:// URL (e.g. "open LinkedIn" -> ' +
          'https://www.linkedin.com/feed/). The user approves it on screen first, ' +
          'so tell them in a few words to check the screen. This only opens the ' +
          'page; you cannot see or act on it afterwards. Prefer this over the ' +
          'chrome_* tools whenever those report the browser is unreachable. If they are talking to ' +
          'you from their phone, the tab still opens on the computer.',
        { url: z.string().describe('The full http(s) URL to open.') },
        async ({ url }) => {
          const href = vet(url)
          if (!href) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'That is not a plain http(s) web address, so it was not opened.' }],
            }
          }
          let reply
          try {
            reply = await ask('confirm', { title: 'Open this link in your browser?', details: href }, 120_000)
          } catch {
            reply = null
          }
          if (reply?.ok !== true) {
            return {
              content: [{ type: 'text', text: 'The user did not approve it on screen, so nothing was opened. Say so in a few words.' }],
            }
          }
          try {
            const [cmd, args] = opener(href)
            // Wait for the process to actually start: a missing opener only
            // surfaces as an async 'error', and "opened" would otherwise be a lie.
            await new Promise((resolve, reject) => {
              const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
              child.once('error', reject)
              child.once('spawn', () => {
                child.unref()
                resolve()
              })
            })
            return { content: [{ type: 'text', text: `Opened ${href} in the browser.` }] }
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not open the browser: ${err?.message ?? err}` }],
            }
          }
        },
      ),
    ],
  })
}
