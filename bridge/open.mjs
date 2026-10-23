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

/**
 * The installed Slack app, at a workspace and optionally a channel.
 *
 * Slack's deep links only know IDs, not names: a workspace is `T…` (or `E…` on
 * Enterprise Grid) and a channel or DM is `C…`, `G…` or `D…`. Names the user
 * uses every day can be mapped once in JARVIS_SLACK_WORKSPACES
 * ("secure sleuths=T0123ABC,client=T0456DEF/C0789GHI", the /C… part being
 * the channel to land in); anything else the model has to
 * be handed, or read off app.slack.com/client/<team>/<channel> in Chrome.
 * The IDs are checked against their exact shape, so nothing but a well-formed
 * slack:// link ever reaches the opener.
 */
// Real IDs always carry digits; requiring one keeps a word such as "general"
// or "testing", upper-cased, from passing for an ID.
const TEAM_ID = /^[TE](?=[A-Z0-9]*\d)[A-Z0-9]{6,14}$/
const CHANNEL_ID = /^[CGD](?=[A-Z0-9]*\d)[A-Z0-9]{6,14}$/

function slackWorkspaces() {
  const map = {}
  for (const pair of (process.env.JARVIS_SLACK_WORKSPACES ?? '').split(',')) {
    const at = pair.lastIndexOf('=')
    if (at < 1) continue
    // "name=T…" or "name=T…/C…", the second opening at that channel by default.
    const name = pair.slice(0, at).trim().toLowerCase()
    const [team, channel] = pair.slice(at + 1).trim().toUpperCase().split('/')
    if (!name || !TEAM_ID.test(team)) continue
    map[name] = { team, channel: channel && CHANNEL_ID.test(channel) ? channel : null }
  }
  return map
}

function slackLink(workspace, channel) {
  const known = slackWorkspaces()
  let team = null
  if (workspace) {
    const w = String(workspace).trim()
    const mapped = known[w.toLowerCase()]
    team = mapped?.team ?? (TEAM_ID.test(w.toUpperCase()) ? w.toUpperCase() : null)
    if (!team) return { error: `I don't know the ID for the "${w}" workspace.` }
    channel = channel || mapped?.channel
  }
  if (channel) {
    const c = String(channel).trim().toUpperCase()
    if (!CHANNEL_ID.test(c)) return { error: 'A channel has to be given by its Slack ID (starts with C, G or D).' }
    if (!team) return { error: 'A channel needs its workspace too.' }
    return { href: `slack://channel?team=${team}&id=${c}` }
  }
  return { href: team ? `slack://open?team=${team}` : 'slack://open' }
}

/** Ask on screen, then hand the link to the OS. Shared by both tools. */
async function confirmAndOpen(ask, title, href, done) {
  let reply
  try {
    reply = await ask('confirm', { title, details: href }, 120_000)
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
    return { content: [{ type: 'text', text: done }] }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Could not open it: ${err?.message ?? err}` }],
    }
  }
}

export function openServer(ask) {
  return createSdkMcpServer({
    name: 'jarvis_open',
    version: '1.0.0',
    instructions:
      "Opens a web page in the user's own browser on this computer, signed in " +
      'as them, or brings up the installed Slack app. Use it when they ask you ' +
      'to open, go to or pull up a site, or to open Slack.',
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
          return confirmAndOpen(ask, 'Open this link in your browser?', href, `Opened ${href} in the browser.`)
        },
      ),
      tool(
        'open_slack',
        'Open the installed Slack desktop app on this computer, optionally at a ' +
          'workspace and channel. workspace is a name the user has mapped in ' +
          'JARVIS_SLACK_WORKSPACES or a Slack team ID (T...); channel is a channel ' +
          'ID (C..., G... or D...), not a name. With no workspace it just brings ' +
          'Slack up. The user approves it on screen first. This only opens Slack: ' +
          'you cannot read or scroll inside the desktop app. To READ messages, use ' +
          'the chrome_* tools on https://app.slack.com instead, where the URL ' +
          '(app.slack.com/client/<team ID>/<channel ID>) also tells you the IDs.',
        {
          workspace: z.string().optional().describe('Mapped workspace name or Slack team ID (T...).'),
          channel: z.string().optional().describe('Slack channel ID (C..., G... or D...).'),
        },
        async ({ workspace, channel }) => {
          const link = slackLink(workspace, channel)
          if (link.error) {
            const known = Object.keys(slackWorkspaces())
            return {
              isError: true,
              content: [{
                type: 'text',
                text: link.error + (known.length ? ` Known workspaces: ${known.join(', ')}.` : ' No workspaces are mapped yet.') +
                  ' Either open Slack without one and let the user pick, or find the ID from app.slack.com in Chrome.',
              }],
            }
          }
          return confirmAndOpen(ask, 'Open Slack?', link.href, 'Slack is opening on the computer.')
        },
      ),
    ],
  })
}
