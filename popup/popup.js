const $ = id => document.getElementById(id)

const sections = ['idle', 'recording', 'review', 'generating', 'edit', 'result', 'error']
function showSection(name) {
  sections.forEach(s => $(`section-${s}`).classList.add('hidden'))
  $(`section-${name}`).classList.remove('hidden')
}

let pollTimer = null
let currentRecording = []
let currentNetworkLog = []
let currentConsoleErrors = []
let startUrl = ''
let generatedYaml = ''
let generatedYaml2 = ''
let currentFlowName = ''
let currentSessionState = null
let isSplitYaml = false
let editParsedSteps = []
let phaseNumber = 1

// ── Provider config ────────────────────────────────────────────────────────────

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    textModel: 'llama-3.3-70b-versatile',
    visionModel: 'llama-3.2-11b-vision-preview'
  },
  ollama: {
    defaultUrl: 'http://127.0.0.1:11434',
    textModel: 'mistral',
    visionModel: 'llama3.2-vision',
    format: 'ollama'
  },
  ollama_fast: {
    defaultUrl: 'http://127.0.0.1:11434',
    textModel: 'llama3.2',
    requiresKey: false
  }
}

function getStorageValue(key) {
  return chrome.storage.local.get(key).then(r => r[key] || null)
}

function toOllamaMessages(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg
    const texts = []
    const images = []
    for (const part of msg.content) {
      if (part.type === 'text') texts.push(part.text)
      if (part.type === 'image_url') {
        const url = part.image_url && part.image_url.url || ''
        const b64 = url.replace(/^data:[^;]+;base64,/, '')
        if (b64) images.push(b64)
      }
    }
    const out = { role: msg.role, content: texts.join('\n') }
    if (images.length) out.images = images
    return out
  })
}

function stepLabel(ev) {
  const el = ev.element || {}
  const sel = el.testid ? `[data-testid="${el.testid}"]`
    : el.id ? `#${el.id}`
    : el.ariaLabel ? `[aria-label="${el.ariaLabel}"]`
    : el.text ? `"${el.text.slice(0, 40)}"`
    : el.tag || '?'

  switch (ev.action) {
    case 'click':       return `Click ${sel}`
    case 'dblclick':    return `Double-click ${sel}`
    case 'type':        return `Type "${(ev.value || '').slice(0, 30)}" into ${sel}`
    case 'navigate':    return `Navigate to ${ev.url}`
    case 'submit':      return `Submit ${sel}`
    case 'hover':       return `Hover ${sel}`
    case 'select':      return `Select "${ev.label || ev.value}" in ${sel}`
    case 'check':       return `Check ${sel}`
    case 'uncheck':     return `Uncheck ${sel}`
    case 'file_upload': return `Upload ${ev.fileCount || 0} file(s) via ${sel}`
    case 'rightclick':  return `Right-click ${sel}`
    case 'focus':       return `Focus ${sel}`
    case 'scroll':      return `Scroll ${ev.direction || ''} ${ev.amount ? `${ev.amount}px` : ''}`.trim()
    case 'keypress': {
      const mods = [ev.ctrl && 'Ctrl', ev.meta && 'Cmd', ev.alt && 'Alt', ev.shift && 'Shift', ev.key].filter(Boolean)
      return `Key ${mods.join('+')}`
    }
    case 'drag': {
      const from = ev.from && ev.from.element || {}
      const fromSel = from.testid ? `[data-testid="${from.testid}"]` : from.text ? `"${from.text.slice(0, 30)}"` : from.tag || '?'
      return `Drag ${fromSel}`
    }
    default: return `${ev.action} ${sel}`
  }
}

function badgeClass(action) {
  const map = {
    click: 'badge-click', dblclick: 'badge-click', hover: 'badge-click',
    drag: 'badge-click', rightclick: 'badge-click', focus: 'badge-click',
    type: 'badge-type', keypress: 'badge-type', select: 'badge-type',
    check: 'badge-type', uncheck: 'badge-type', file_upload: 'badge-type',
    navigate: 'badge-navigate', scroll: 'badge-navigate',
    submit: 'badge-submit'
  }
  return map[action] || 'badge-click'
}

function updatePreview(recording) {
  const list = $('preview-list')
  const last5 = recording.slice(-5)
  if (last5.length === 0) {
    list.innerHTML = '<li class="preview-empty">Waiting for interactions...</li>'
    return
  }
  list.innerHTML = last5.map(ev => `<li>${stepLabel(ev)}</li>`).join('')
  $('step-count').textContent = `${recording.length} step${recording.length !== 1 ? 's' : ''}`
}

function estimateRecordingStats(recording) {
  let lowCount = 0
  let otpCount = 0

  for (const ev of recording) {
    if (ev.action === 'navigate') continue
    const el = ev.element || {}
    const fieldName = [el.id, el.name, el.placeholder, el.ariaLabel, el.nearbyLabel].join(' ').toLowerCase()

    if (/\botp\b|verification|passcode|verify.?code|auth.?code/.test(fieldName)) otpCount++
    if (ev.action === 'type' && /^\d{4,6}$/.test((ev.value || '').trim())) otpCount++

    if (!el.testid && !el.id && !el.ariaLabel) {
      if (['svg', 'path', 'i'].includes(el.tag) || (!el.text && !el.name && !el.placeholder)) lowCount++
    }
  }

  return { lowCount, otpCount: Math.min(otpCount, 99) }
}

function renderSummaryBar(recording) {
  const bar = $('summary-bar')
  const total = recording.length
  const { lowCount, otpCount } = estimateRecordingStats(recording)

  const hasIssues = lowCount > 0 || otpCount > 0
  const iconHtml = hasIssues
    ? '<span class="summary-icon">!</span>'
    : '<span class="summary-icon summary-icon-ok">✓</span>'

  const parts = [`<strong>${total}</strong> steps recorded`]
  if (lowCount > 0) parts.push(`<span class="summary-warn">${lowCount} low reliability</span>`)
  if (otpCount > 0) parts.push(`<span class="summary-warn">${otpCount} OTP detected</span>`)

  bar.className = 'summary-bar ' + (hasIssues ? 'summary-amber' : 'summary-green')
  bar.innerHTML = `${iconHtml} ${parts.join(' · ')}`
  bar.classList.remove('hidden')
}

function renderStepsList(recording) {
  const ul = $('steps-list')
  $('review-step-count').textContent = `${recording.length} step${recording.length !== 1 ? 's' : ''}`
  renderSummaryBar(recording)

  if (recording.length === 0) {
    ul.innerHTML = '<li style="padding:10px;color:#aaa;font-style:italic">No steps recorded.</li>'
    return
  }
  ul.innerHTML = recording.map((ev, i) => `
    <li>
      <span class="step-num">${i + 1}</span>
      <span class="step-text">${stepLabel(ev)}</span>
      <span class="step-badge ${badgeClass(ev.action)}">${ev.action}</span>
    </li>
  `).join('')
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_RECORDING' }, res => {
      if (res) updatePreview(res.recording || [])
    })
  }, 800)
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// ── Prompt pre-processing helpers ────────────────────────────────────────────

function cleanUrl(url) {
  try {
    const u = new URL(url)
    const TRACKING = ['utm_source','utm_medium','utm_campaign','utm_term',
      'utm_content','gclid','fbclid','ref','_ga','mc_cid','mc_eid']
    TRACKING.forEach(p => u.searchParams.delete(p))
    return u.toString()
  } catch {
    return url
  }
}

function describeShape(obj, depth = 0) {
  if (depth > 2) return '...'
  if (obj === null) return 'null'
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return `[${describeShape(obj[0], depth + 1)}, ...]`
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).slice(0, 6)
    const pairs = keys.map(k => `${k}: ${describeShape(obj[k], depth + 1)}`)
    return `{${pairs.join(', ')}}`
  }
  return typeof obj
}

function extractShape(body) {
  if (!body) return null
  try {
    return describeShape(JSON.parse(body))
  } catch {
    return body.slice(0, 100)
  }
}

function filterNetworkForPrompt(networkEntries) {
  if (!networkEntries || networkEntries.length === 0) return []

  const SKIP_PATTERNS = [
    'analytics', 'tracking', 'metrics', 'pixel', 'beacon',
    'gtm', '/ga', 'google-analytics', 'facebook', 'hotjar',
    'intercom', 'mixpanel', 'segment', 'amplitude', 'heap',
    'clarity', 'sentry', 'cdn', 'static', 'assets', 'fonts',
    'sockjs', 'websocket', 'livereload', 'webpack-hmr',
    '.ico', '.svg', '.png', '.jpg', '.gif', '.woff', '.css', '.js'
  ]
  const SKIP_METHODS = ['GET', 'HEAD', 'OPTIONS']

  const failures = networkEntries.filter(n => n.response_status >= 400)

  const meaningful = networkEntries.filter(n => {
    if (n.response_status >= 400) return false
    if (SKIP_METHODS.includes((n.method || '').toUpperCase())) return false
    const url = (n.url || '').toLowerCase()
    if (SKIP_PATTERNS.some(p => url.includes(p))) return false
    return true
  })

  return [...failures, ...meaningful].slice(0, 3).map(n => ({
    method: n.method,
    url: n.url,
    request_body: n.request_body ? n.request_body.slice(0, 100) : null,
    response_status: n.response_status,
    response_shape: extractShape(n.response_body),
    timing_ms: n.timing_ms,
    redirected: n.redirected || false
  }))
}

function isSameElement(a, b) {
  if (!a || !b) return false
  if (a.testid && a.testid === b.testid) return true
  if (a.id && a.id === b.id) return true
  if (a.name && a.name === b.name) return true
  if (a.ariaLabel && a.ariaLabel === b.ariaLabel) return true
  return false
}

function deduplicateRecording(recording) {
  // Pass 1: strip all focus events before anything else sees them
  const noFocus = recording.filter(e => e.action !== 'focus')

  const result = []

  for (let i = 0; i < noFocus.length; i++) {
    let event = noFocus[i]  // let — may be replaced with url-cleaned copy below
    const prev = result.length > 0 ? result[result.length - 1] : null

    // ── Type deduplication ─────────────────────────────────────────────────
    if (event.action === 'type') {
      const sel = event.element?.id || event.element?.testid ||
                  event.element?.name || event.element?.placeholder
      const laterType = noFocus.slice(i + 1).find(e =>
        e.action === 'type' &&
        (e.element?.id || e.element?.testid ||
         e.element?.name || e.element?.placeholder) === sel
      )
      if (laterType) continue
    }

    // ── Click before type/select/check ────────────────────────────────────
    if (event.action === 'click') {
      const upcoming = noFocus.slice(i + 1, i + 4)
      const hasInputOnSame = upcoming.some(e =>
        (e.action === 'type' || e.action === 'select' || e.action === 'check') &&
        isSameElement(event.element, e.element)
      )
      if (hasInputOnSame) continue
    }

    // ── Click after type on same element (within 1s) ──────────────────────
    if (event.action === 'click' && prev && prev.action === 'type' &&
        event.timestamp - prev.timestamp < 1000 &&
        isSameElement(event.element, prev.element)) continue

    // ── Click after select on same element ───────────────────────────────
    if (event.action === 'click' && prev && prev.action === 'select' &&
        isSameElement(event.element, prev.element)) continue

    // ── Consecutive scrolls in same direction — keep only the last ────────
    if (event.action === 'scroll' && prev && prev.action === 'scroll' &&
        prev.direction === event.direction) {
      result.pop()
    }

    // ── Submit after click with network activity on same form ─────────────
    if (event.action === 'submit') {
      const lookback = result.slice(-3)
      const clickWithNetwork = lookback.some(p =>
        p.action === 'click' &&
        p.network && p.network.length > 0 &&
        isSameElement(event.element, p.element)
      )
      if (clickWithNetwork) continue
    }

    // ── Submit immediately after click on same form within 500ms ──────────
    if (event.action === 'submit' && prev && prev.action === 'click' &&
        event.timestamp - prev.timestamp < 500 &&
        isSameElement(event.element, prev.element)) continue

    // ── Submit within 2 steps of a click on the same form ─────────────────
    if (event.action === 'submit') {
      const recentClick = result.slice(-2).some(p =>
        p.action === 'click' && isSameElement(event.element, p.element)
      )
      if (recentClick) continue
    }

    // ── Navigate after click (click implies the navigation) ───────────────
    if (event.action === 'navigate' && prev) {
      if (prev.action === 'click' && event.timestamp - prev.timestamp < 3000) continue
      if (event.url === prev.url) continue
    }

    // Strip tracking params from navigate URLs
    if (event.action === 'navigate' && event.url) {
      event = { ...event, url: cleanUrl(event.url) }
    }

    result.push(event)
  }

  // Pass 2: collapse "scroll + click(s) + check/uncheck on same element" sequences
  const collapsed = []
  for (let i = 0; i < result.length; i++) {
    const ev = result[i]
    if ((ev.action === 'check' || ev.action === 'uncheck') && collapsed.length > 0) {
      const windowStart = Math.max(0, collapsed.length - 7)
      const window = collapsed.slice(windowStart)
      const hasScroll = window.some(e => e.action === 'scroll')
      const hasClickOnSame = window.some(e =>
        e.action === 'click' && isSameElement(e.element, ev.element)
      )
      if (hasScroll && hasClickOnSame) {
        const before = collapsed.slice(0, windowStart)
        const filtered = window.filter(e =>
          e.action !== 'scroll' && !(e.action === 'click' && isSameElement(e.element, ev.element))
        )
        collapsed.length = 0
        collapsed.push(...before, ...filtered, { ...ev, scroll_into_view: true })
        continue
      }
    }
    collapsed.push(ev)
  }

  // Pass 3: keep only the last scroll before each significant action
  const SIGNIFICANT = new Set(['click', 'dblclick', 'type', 'submit', 'select', 'check', 'uncheck', 'keypress', 'file_upload'])
  const scrollCleaned = []
  for (let i = 0; i < collapsed.length; i++) {
    const ev = collapsed[i]
    if (ev.action === 'scroll') {
      const ahead = collapsed.slice(i + 1)
      const nextSigIdx = ahead.findIndex(e => SIGNIFICANT.has(e.action))
      if (nextSigIdx >= 0) {
        const between = ahead.slice(0, nextSigIdx)
        if (between.some(e => e.action === 'scroll')) continue
      }
    }
    scrollCleaned.push(ev)
  }

  return scrollCleaned
}

// ── Groq vision — element finding for weak selectors ─────────────────────────

async function findElementWithVision(screenshotBase64, intent, elements, groqKey, ollamaUrl, fastMode) {
  if (!screenshotBase64 || (!groqKey && !ollamaUrl)) return null
  try {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
        {
          type: 'text',
          text: `Find this element on the page.
Intent: ${intent}

Available elements in DOM:
${elements.map(e => `- ${e && e.tag} text="${e && e.text}" id="${e && e.id}" testid="${e && e.testid}" placeholder="${e && e.placeholder}"`).join('\n')}

Reply with JSON only, no explanation:
{"found": true, "selector": "css selector", "fallback_text": "visible text", "confidence": "high|medium|low"}
or if not found:
{"found": false, "reason": "why"}`
        }
      ]
    }]
    const content = await callLLM(messages, true, groqKey, ollamaUrl, fastMode)
    if (!content) return null
    return JSON.parse(content.replace(/```json|```/g, '').trim())
  } catch {
    return null
  }
}

async function enhanceWeakSelectorsWithVision(steps, groqKey, ollamaUrl, fastMode) {
  const enhanced = []
  for (const event of steps) {
    if (event.screenshot && event.action === 'click' &&
        event.element && !event.element.id && !event.element.testid && !event.element.ariaLabel) {
      const result = await findElementWithVision(
        event.screenshot,
        event.element.text || 'interactive element',
        [event.element],
        groqKey,
        ollamaUrl,
        fastMode
      )
      if (result && result.found) {
        enhanced.push({
          ...event,
          vision_selector: result.selector,
          vision_fallback: result.fallback_text,
          vision_confidence: result.confidence
        })
        continue
      }
    }
    enhanced.push(event)
  }
  return enhanced
}

// ── Strip noise before prompt ─────────────────────────────────────────────────

function stripEmptyFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripEmptyFields)
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([, v]) => v !== '' && v !== false && v !== 0 && v !== null && v !== undefined)
        .map(([k, v]) => [k, stripEmptyFields(v)])
    )
  }
  return obj
}

// ── Prompt builder ────────────────────────────────────────────────────────────

// Returns true if an id looks auto-generated / unstable. These ids change on
// every render so they must not be passed to the LLM as candidate selectors.
function isDynamicId(id) {
  if (!id || typeof id !== 'string') return false
  if (id.includes('_r_')) return true                  // React's useId pattern
  if (/[A-Za-z0-9]{8,}/.test(id) && /[0-9]/.test(id)) return true  // long mixed alnum
  if (/--[a-z0-9]+$/i.test(id) && id.length > 12) return true       // CSS-modules / radix
  if (/^:r[0-9a-z]+:$/.test(id)) return true            // Radix / React-Aria
  return false
}

// tagPath becomes "div > div > div > a" when no parent has an id or data-testid.
// Such a path is useless as a selector — drop it. Only keep paths that anchor on
// at least one semantic attribute the LLM can build a real selector from.
function tagPathHasSemanticAnchor(path) {
  if (!path) return false
  return path.includes('[data-testid=') || /#[A-Za-z][\w-]+/.test(path)
}

function describeAction(event, i) {
  const el = event.element
  const safeId = el && el.id && !isDynamicId(el.id) ? el.id : ''
  const safeTagPath = el && el.tagPath && tagPathHasSemanticAnchor(el.tagPath) ? el.tagPath : ''
  const elDesc = el ? [
    el.testid        ? `data-testid="${el.testid}"`        : '',
    safeId           ? `id="${safeId}"`                    : '',
    el.ariaLabel     ? `aria-label="${el.ariaLabel}"`      : '',
    el.name          ? `name="${el.name}"`                 : '',
    el.ariaRole      ? `role="${el.ariaRole}"`             : '',
    el.inputType     ? `type="${el.inputType}"`            : '',
    el.text          ? `visibleText="${el.text.slice(0, 80)}"` : '',
    el.placeholder   ? `placeholder="${el.placeholder}"`   : '',
    el.nearbyLabel   ? `label="${el.nearbyLabel}"`         : '',
    el.nearbyHeading ? `heading="${el.nearbyHeading}"`     : '',
    el.formContext   ? `form="${el.formContext}"`          : '',
    el.sectionContext ? `section="${el.sectionContext}"`   : '',
    safeTagPath      ? `path="${safeTagPath}"`             : '',
    el.inShadowDOM   ? 'shadow-dom=true'                   : '',
    el.isDisabled    ? 'disabled=true'                     : ''
  ].filter(Boolean).join(', ') : ''

  const n = i + 1
  switch (event.action) {
    case 'click':
      return `${n}. CLICK: ${el && el.tag || 'element'} [${elDesc}] at ${event.url}`
    case 'dblclick':
      return `${n}. DOUBLE_CLICK: ${el && el.tag || 'element'} [${elDesc}] at ${event.url}`
    case 'hover':
      return `${n}. HOVER: ${el && el.tag || 'element'} [${elDesc}] tooltip="${event.tooltip || ''}" at ${event.url}`
    case 'drag': {
      const from = event.from && event.from.element
      const to   = event.to   && event.to.element
      return `${n}. DRAG: from [${from && (from.text || from.testid) || 'element'}] to [${to && (to.text || to.testid) || 'target'}] at ${event.url}`
    }
    case 'type':
      return `${n}. TYPE: value="${event.value}" into ${el && el.tag} [${elDesc}] at ${event.url}`
    case 'select':
      return `${n}. SELECT: option="${event.label}" (value="${event.value}") in ${el && el.tag} [${elDesc}] at ${event.url}`
    case 'check':
      return `${n}. CHECK: checkbox [${elDesc}] at ${event.url}`
    case 'uncheck':
      return `${n}. UNCHECK: checkbox [${elDesc}] at ${event.url}`
    case 'scroll':
      return `${n}. SCROLL: ${event.direction} ${event.amount}px at ${event.url}`
    case 'navigate': {
      const sysTag = (event.event_type === 'auth_redirect' || event.event_type === 'system_redirect')
        ? ` [SYSTEM_EVENT:${event.event_type}]`
        : ''
      return `${n}. NAVIGATE: to ${event.url}${event.spa ? ' (SPA)' : ''}${event.new_tab ? ' (new tab)' : ''}${sysTag}`
    }
    case 'submit':
      return `${n}. SUBMIT: form [${elDesc}] at ${event.url}`
    case 'keypress': {
      const mod = [event.ctrl && 'Ctrl', event.meta && 'Cmd', event.alt && 'Alt', event.shift && 'Shift'].filter(Boolean).join('+')
      return `${n}. KEYPRESS: ${mod ? mod + '+' : ''}${event.key} at ${event.url}`
    }
    case 'file_upload':
      return `${n}. FILE_UPLOAD: ${event.fileCount} file(s) type=${(event.fileTypes || []).join(',') || 'unknown'} at ${event.url}`
    case 'rightclick':
      return `${n}. RIGHT_CLICK: [${elDesc}] at ${event.url}`
    case 'focus':
      return `${n}. FOCUS: ${el && el.tag} [${elDesc}] at ${event.url}`
    default:
      return `${n}. ${event.action.toUpperCase()}: at ${event.url}`
  }
}

function buildGroqPrompt(steps, networkLog, consoleErrors, flowName, expectedOutcome, startUrl, partNote, sessionState) {
  const stepsText = steps.map((event, i) => {
    const event_ = stripEmptyFields(event)
    const base = describeAction(event_, i)

    const filteredNetwork = filterNetworkForPrompt(event_.network)
    let networkDesc = ''
    if (filteredNetwork.length > 0) {
      networkDesc = '\n   Network:\n' + filteredNetwork.map(n =>
        `   → ${n.method} ${n.url} ${n.response_status} ${n.timing_ms}ms` +
        (n.request_body ? `\n     body: ${n.request_body}` : '') +
        (n.response_shape ? `\n     response shape: ${n.response_shape}` : '') +
        (n.redirected ? '\n     [redirected]' : '')
      ).join('\n')
    }

    let consoleDesc = ''
    if (event_.console_errors && event_.console_errors.length > 0) {
      consoleDesc = '\n   Console:\n' + event_.console_errors.map(e =>
        `   [${e.type}] ${e.text}`
      ).join('\n')
    }

    let visionHint = ''
    if (event_.vision_selector) {
      visionHint = `\n   Vision: selector="${event_.vision_selector}" fallback="${event_.vision_fallback || ''}" confidence=${event_.vision_confidence || 'low'}`
    }

    return base + networkDesc + consoleDesc + visionHint
  }).join('\n\n')

  const truncationNote = partNote || ''

  const failures = (networkLog || []).filter(n => n.failed)
  const networkSummary = failures.length > 0
    ? 'Unlinked network failures (not attributed to a specific step):\n' + failures.map(f => `  ${f.status || 'ERR'} ${f.url}`).join('\n')
    : 'No unlinked network failures.'

  const errorSummary = (consoleErrors || []).length > 0
    ? 'Unlinked console errors (not attributed to a specific step):\n' + consoleErrors.map(e => `  [${e.type}] ${e.text}`).join('\n')
    : 'No unlinked console errors.'

  return `You are a senior test automation engineer converting a recorded user flow into a production-quality YAML test file.

Flow name: ${flowName}
Start URL: ${startUrl}
Expected outcome: ${expectedOutcome}
Session state: ${JSON.stringify(sessionState || {})}

Recorded interactions:
${stepsText}
${truncationNote}

${networkSummary}

${errorSummary}

════════════════════════════════════════════
OUTPUT FORMAT — follow exactly
════════════════════════════════════════════

Output this exact top-level structure:

metadata:
  name: "flow-name-in-kebab-case"
  version: "2.0.0"
  baseUrl: "the start URL"
  timeout: 30000
  description: >
    One sentence describing what this flow does
  # Use timeout: 45000 when the start URL is a Next.js / RSC / Remix app
  # (cuemath.com, vercel.app, *.now.sh, anything with /_next/ in network calls)
  # — first-load hydration regularly exceeds 30s on these.

steps:

  # ── PHASE N: Phase Name ──────────────────────

  - id: kebab-case-step-id
    action: navigate|click|type|evaluate|waitForSelector|assert
    [fields per action type — see below]

────────────────────────────────────────────
ACTION TYPES AND REQUIRED FIELDS
────────────────────────────────────────────

NAVIGATE:
  - id: navigate-somewhere
    action: navigate
    url: "https://full-url.com/path"
    intent: A direct load of <page name> at <path>, used to skip <what was clicked-through in the recording>. The destination page renders <what visible content it primarily shows>.
    expect: URL is exactly /<route> and the page shows <heading text> with <one or two other concrete elements> visible above the fold.
    critical: true
    continueOnFailure: false

TYPE:
  - id: type-fieldname
    action: type
    selector: 'CSS selector'
    fallback:
      - 'fallback selector 1'
      - 'fallback selector 2'
    intent: A <text|email|tel> input field labeled "<label>" (or with placeholder "<placeholder>"), located <where on the page — which form, which section, which neighbouring field>. Typing into it <what part of the payload it fills>.
    expect: The <field name> input's value attribute equals "<value>"; no validation error renders beneath; <adjacent field name> remains visible and reachable.
    value: "the text to type"
    waitAfter: 300
    continueOnFailure: true

CLICK:
  - id: click-button-name
    action: click
    selector: 'CSS selector'
    fallback:
      - 'fallback selector 1'
      - 'fallback selector 2'
    intent: <Visual + role description — "a small circular avatar image button" / "a primary blue submit button labeled Reserve Now" / "a tab in a horizontal tab strip">, located <where — which container, which corner, beside what>. Clicking it <the immediate observable effect — opens X dropdown / navigates to Y / submits Z form>.
    expect: <URL change — "URL contains /path"> AND <specific element/text newly visible — "a panel containing text X and link Y"> AND <optional what disappears>.
    waitAfter: 1000
    critical: true
    continueOnFailure: false

EVALUATE (use for scrolling — never use raw scroll steps):
  - id: scroll-to-section
    action: evaluate
    value: "document.getElementById('sectionId')?.scrollIntoView({behavior:'instant',block:'center'})"
    intent: Scroll <element description — "the booking form containing the Firstname/Lastname/Email/Phone inputs"> into the vertical center of the viewport so <next step's target> is on-screen for the next step.
    expect: <Target element> is within the viewport (its top edge between 50 and 500 pixels from the viewport top); no scroll-triggered spinner or skeleton remains.
    waitAfter: 500
    continueOnFailure: true

WAITFORSELECTOR:
  - id: wait-for-form
    action: waitForSelector
    selector: 'CSS selector or REPLACE_WITH_ACTUAL_FORM_SELECTOR'
    fallback:
      - 'form'
      - 'input'
    intent: <Element description + label/role>, located <where>. Wait for it to be present, enabled, and past its mount animation so the next <type/click/select> step does not race React hydration.
    expect: An element matching <selector or role + name> is present, is not disabled, has tabindex >= 0, and renders a non-zero bounding box.
    timeout: 8000
    critical: true
    continueOnFailure: false

ASSERT:
  - id: assert-outcome
    action: assert
    assertion:
      field: body
      operator: contains
      value: "Expected text on page"
    fallback_assertion:
      field: url
      operator: contains
      value: "/expected-path"
    intent: Verify the <step that just ran> produced a server-confirmed state by checking <which signal proves persistence — reference code, confirmation banner, server-rendered username>.
    expect: URL path contains /<fragment>; page body contains the exact text "<text>" AND <one or two more concrete signals — element, count, regex pattern>; <previous-screen element> is no longer in the DOM.
    continueOnFailure: true

────────────────────────────────────────────
RULES — follow every rule exactly
────────────────────────────────────────────

── SELECTORS ────────────────────────────────

Priority order — use first available semantic attribute from the recording:
  1. [data-testid="value"]            — most stable, survives refactors
  2. [aria-label="value"]              — semantic, accessibility-driven
  3. [name="value"]                    — form fields
  4. [role="..."] + accessible name    — landmarks, buttons, links
  5. input[type="email"], button[type="submit"] — typed form controls
  6. #id — ONLY if the id looks human-readable and stable. SKIP if:
       • starts with ":r" (React useId)
       • contains "_r_"
       • has 8+ random alphanumeric chars
       • ends with "--<hash>" (CSS modules / Radix)
  7. If no semantic selector was captured in the recording:
       selector: 'REPLACE_WITH_ACTUAL_SELECTOR'
       aiDriven: true
     DO NOT invent a data-testid or any other attribute value that does not
     appear in the recording. Hallucinated selectors fail silently at replay.

Always include 2-3 fallback selectors, cascading from specific to generic.
The most generic fallback (e.g. button[type="submit"]) goes LAST, never first.
Every fallback must be a real, syntactically valid CSS selector.

NEVER use:
  - Bare tag names as primary: button, a, div, span, input
  - nth-child or nth-of-type
  - Deeply nested chains: div > div > div > a
  - Dynamic React IDs: span#_r_1r_--label, #:r3:, or anything matching the SKIP list above
  - Non-standard syntax: [text="..."] (not a real attribute), [testid="..."] (missing data-),
    [aria-label="..."] without quotes, or any made-up attribute name
  - Generic role-only fallbacks like span[role="link"], span[role="menuitem"],
    or div[role="button"] without an additional discriminator
  - Hashed or minified class names like .css-1a2b3c4
  - The "path=" or "visibleText=" values from the recording context — these are
    descriptive metadata, NOT valid CSS selectors

── NAVIGATION ───────────────────────────────

Navigate directly to a URL whenever the full URL is known — do not click through to it.
Direct navigation is faster, more reliable, and eliminates a failure point.
NEVER emit both a click step and a navigate step to the same destination. Pick one.
If you recorded a click that caused a navigation, output the navigate step only.

── FORM HYDRATION GUARD ─────────────────────

Before any block of form interactions (type, select, check), insert a waitForSelector
step targeting the first input in the form. This is mandatory — it is the hydration
guard that ensures the form is interactive before typing begins.

Example:
  - id: wait-for-login-form
    action: waitForSelector
    selector: 'input[name="email"]'
    fallback:
      - 'input[type="email"]'
      - 'form input'
    intent: Wait for the login form to be ready before entering credentials
    expect: Email input is visible and interactive
    timeout: 8000
    critical: true
    continueOnFailure: false

── SCROLLING ────────────────────────────────

Always use evaluate with scrollIntoView — never output raw pixel scroll steps.
Add a scroll/evaluate step before asserting on any content that may be below the fold.
Use: document.querySelector('selector')?.scrollIntoView({behavior:'instant',block:'center'})
Or:  window.scrollTo({top: 0, behavior: 'instant'}) to scroll to top.

── STEP IDS ─────────────────────────────────

Step IDs must be kebab-case, descriptive, and unique.
Good: navigate-home, click-check-availability, type-firstname, assert-confirmed
Bad: step_1, step1, step-1

── CRITICAL STEPS ───────────────────────────

Set critical: true and continueOnFailure: false for:
  - Every navigate step
  - waitForSelector guards before form blocks
  - Form submission / reserve / proceed / confirm buttons
  - Authentication steps

Set continueOnFailure: true (omit critical) for:
  - Individual type/select/check fields inside a form — never mark these critical
  - Scroll steps
  - Hover steps
  - Secondary clicks that have a navigate fallback right after

── ASSERTIONS ───────────────────────────────

Every assert step MUST have a fallback_assertion using url contains as the secondary check.
Assert BEFORE navigating away from the page you want to verify — never assert after leaving.
After any form submission, add a waitForSelector targeting the confirmation element
rather than relying solely on waitAfter. Then assert on the confirmation content.
After each major phase transition, add a sanity-check assert to confirm you are on
the correct page before the next phase begins.

Example post-submission pattern:
  - id: wait-for-confirmation
    action: waitForSelector
    selector: '[data-testid="booking-confirmation"]'
    fallback:
      - '.confirmation-message'
      - 'h1'
    intent: Wait for booking confirmation to appear after form submission
    expect: Confirmation message is visible
    timeout: 10000
    critical: true
    continueOnFailure: false

  - id: assert-booking-confirmed
    action: assert
    assertion:
      field: body
      operator: contains
      value: "Booking confirmed"
    fallback_assertion:
      field: url
      operator: contains
      value: "/confirmation"
    intent: Verify the booking was successfully submitted and confirmation is shown
    expect: Page shows booking confirmation message
    continueOnFailure: true

── UNKNOWN SELECTORS ────────────────────────

When the exact selector cannot be determined from the recording:
  selector: 'REPLACE_WITH_ACTUAL_SELECTOR'
  aiDriven: true
Add the strongest available fallback selectors so the engine can attempt the step.

── PHASE COMMENTS ───────────────────────────

Group related steps with YAML comments. Number phases sequentially from 1
upward across the entire flow — NEVER restart numbering. A flow with seven
logical sections has phases 1 through 7, not 1-4 followed by 1-3.

  # ── PHASE 1: Navigation ──────────────────────
  # ── PHASE 2: Form Filling ────────────────────

── waitAfter ────────────────────────────────

waitAfter is mandatory when the app needs time to respond:
  - After any navigate step: 800-1000ms minimum
  - After click that triggers data load or re-render: 1000-3000ms
  - After form submission: 1500-3000ms
  - After type into search or date field: 300-500ms
  - After evaluate scroll: 500ms
  - Simple clicks with no network effect: omit waitAfter

── INTENT AND EXPECT ────────────────────────

intent and expect are how a downstream AI orchestrator finds elements and
verifies steps when selectors break. Write them so a model that has NEVER
seen this site can locate the target element on the live DOM using ONLY
your intent string, and confirm the step worked using ONLY your expect.

intent DESCRIBES THE ELEMENT — not the user's goal, not the step's purpose
in the flow. Three questions, always:

  1. WHERE on the page — concrete spatial / structural location:
       "in the top-right corner of the fixed navigation bar"
       "at the bottom of the booking form, beside the Cancel button"
       "in the horizontal tab strip below the repository name"
       "in the list of pinned repositories on the profile page"
     Avoid abstract location like "in the auth flow" — that is not findable.

  2. WHAT IT LOOKS LIKE or ITS ACCESSIBLE ROLE — visual + semantic signature:
       "a small circular avatar image button"
       "a linked text item showing the repository name, sometimes with a
        Public badge to its right"
       "one tab in a horizontal tab list, labeled Actions"
       "a primary call-to-action button styled as a filled blue rectangle
        containing the text Reserve Now"
     Always include visible text if there is any.

  3. WHAT IT TRIGGERS — the immediate observable effect of interaction:
       "opens a dropdown menu containing Profile, Repositories, Sign out"
       "navigates to the repository's main page showing the file tree"
       "submits the booking form and shows a confirmation banner"
     Be concrete about what appears next, not abstract about user journeys.

Do NOT write intent as "Click X to do Y" — that is action+goal framing and
strands the AI when X is missing. Write intent as a description of X that
could be read aloud to someone looking at the page.

expect DESCRIBES VERIFIABLE PAGE STATE — concrete things the AI can check:

  1. URL after this step — the exact path or path-contains fragment:
       "URL contains /monishsolanki-rm/flow-recorder/actions"
       "URL path is /reservation/confirm"

  2. SPECIFIC text or elements newly visible — name them. Multiple if possible,
     any one of which confirms success:
       "page body contains the tab labels Code, Issues, Pull requests, Actions"
       "a heading with the exact text Booking Confirmed appears above a
        reference code matching the pattern BK-\\d{4}"
       "the file tree on the right shows entries README.md and manifest.json"

  Optionally name what should NO LONGER be visible (state transition):
       "the original booking form is no longer present in the DOM"

Length: intent typically 35–70 words across the three questions. expect
typically 20–50 words. Long enough to be specific; short enough to be
falsifiable. Every word should be checkable against a real DOM.

EXAMPLES — element-descriptive form:

click-profile:
  intent: A small circular profile avatar image button located in the
    top-right corner of the fixed GitHub navigation bar. It sits beside the
    notifications bell and shows the current user's profile photo. Clicking
    it opens a dropdown menu containing links to Your profile, Your
    repositories, Settings, and Sign out.
  expect: A dropdown panel appears anchored below the avatar containing a
    "Signed in as" header followed by the username "monishsolanki-rm" and
    a Your profile link; the page URL has not yet changed.

click-repository:
  intent: A linked text item showing the repository name "flow-recorder",
    appearing in the list of pinned or recently visited repositories on the
    profile page. The link may have a small Public badge to its right and
    sits in a card-style row. Clicking it opens the repository's main page
    where the file tree is displayed.
  expect: URL contains /monishsolanki-rm/flow-recorder and the page shows
    a file listing with entries including README.md and manifest.json; a
    horizontal tab strip with Code, Issues, Pull requests, Actions, Wiki
    is visible above the file tree.

click-actions:
  intent: The Actions tab inside the horizontal repository navigation strip
    that runs below the repository name and description. It is one of
    several sibling tabs (Code, Issues, Pull requests, Actions, Wiki) and
    sits to the right of Pull requests. Clicking it shows CI/CD workflow
    runs for the repository.
  expect: URL contains /monishsolanki-rm/flow-recorder/actions and the
    page shows either a heading "Workflow runs" with a list of past runs,
    or the empty-state prompt "Get started with GitHub Actions" inviting
    the user to choose a workflow template.

type-firstname:
  intent: A text input field labeled "Firstname" (or with placeholder
    "Firstname"), located in the booking form as the first field in the
    guest details section, immediately above the Lastname input. Typing
    into it populates the first-name portion of the reservation payload.
  expect: The Firstname input's value attribute equals "monish"; no
    validation error message is rendered beneath the field; the Lastname
    input directly below remains visible and reachable.

navigate-summer-programs:
  intent: A direct load of the Cuemath blog article at
    /blog/best-summer-math-programs-2026/, used to skip the menu traversal
    captured in the recording and put the user straight on the article.
  expect: URL is exactly /blog/best-summer-math-programs-2026/ and the
    page shows an article heading containing the text "Summer Math
    Programs" with publication metadata (date, author) visible beneath it.

wait-for-firstname:
  intent: The Firstname text input inside the booking form. Wait for it
    to be present in the DOM, enabled, and past its mount animation so
    the next type step does not race React hydration.
  expect: An input element matching [aria-label="Firstname"] is present,
    is not disabled, has tabindex >= 0, and renders a non-zero bounding
    box on screen.

assert-booking-confirmed:
  intent: Verify that the booking submission resulted in a server-confirmed
    reservation. Look for both a confirmation message and a server-generated
    reference code in the page body.
  expect: URL path contains /reservation or /confirmation; the page body
    contains the exact text "Booking Confirmed" and a reference code
    matching pattern BK-\\d{4,}; the original Firstname / Lastname / Email
    inputs from the booking form are no longer in the DOM.

evaluate-scroll-to-form:
  intent: Scroll the booking form into the vertical center of the viewport.
    The target is the form element containing the Firstname / Lastname /
    Email / Phone inputs. This brings the first input into view so the
    next type step does not act on an offscreen field.
  expect: The Firstname input is within the viewport (its top edge between
    50 and 500 pixels from the viewport top), and no scroll-triggered
    spinner or skeleton placeholder remains visible.

Bad — DO NOT WRITE:
  intent: "Click the profile picture"            (no location, no appearance, no effect)
  intent: "Click Reserve to submit"              (action+goal, not element description)
  intent: "Submit form"                          (no element, no place, no signature)
  expect: "Profile page is visible"              (which page? what makes it the profile page?)
  expect: "Click successful"                     (clicks always succeed — say what changed)
  expect: "Page loads"                           (every step loads something — what specifically?)
  expect: "booking confirmed"                    (vague, lowercase, nothing to grep for)

Output YAML only. No markdown fences. No explanation. No invented steps.
════════════════════════════════════════════`
}

// ── Universal LLM call — Claude primary, Groq secondary, Ollama fallback ──────

async function callLLM(messages, useVision, groqKey, ollamaUrl, fastMode) {
  let lastError = null

  // Claude — highest quality, used when key is present and not a vision call
  if (!useVision) {
    const claudeApiKey = await getStorageValue('claudeApiKey')
    if (claudeApiKey) {
      try {
        const claudeMessages = messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content
        }))
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': claudeApiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-opus-4-5',
            max_tokens: 4096,
            messages: claudeMessages
          })
        })
        if (response.status === 401) throw new Error('Invalid Claude API key. Check your key at console.anthropic.com')
        if (response.status === 429) throw new Error('Claude rate limit hit. Try again in a moment or use Groq.')
        if (!response.ok) throw new Error(`Claude API error ${response.status}.`)
        const data = await response.json()
        let content = (data.content && data.content[0] && data.content[0].text || '').trim()
        content = content.replace(/^```ya?ml\s*/i, '').replace(/```\s*$/i, '').trim()
        if (!content.includes('steps:')) throw new Error('Claude returned invalid YAML.')
        return content
      } catch (e) {
        lastError = e
        // Fall through to Groq if Claude fails
      }
    }
  }

  if (groqKey) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response
      try {
        response = await fetch(PROVIDERS.groq.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqKey}`
          },
          body: JSON.stringify({
            model: useVision ? PROVIDERS.groq.visionModel : PROVIDERS.groq.textModel,
            messages,
            max_tokens: useVision ? 150 : 4096,
            temperature: 0
          })
        })
      } catch {
        lastError = new Error('Network error. Check your internet connection.')
        break
      }
      if (response.status === 429) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 15000)); continue }
        lastError = new Error('Groq rate limit hit.')
        break
      }
      if (response.status === 401) throw new Error('Invalid Groq API key. Check your key at console.groq.com')
      if (response.status === 413) throw new Error('Recording too long. Try recording a shorter flow.')
      if (!response.ok) {
        if (attempt < 2) continue
        lastError = new Error(`Groq API error ${response.status}.`)
        break
      }
      const data = await response.json()
      let content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim()
      if (!useVision) {
        content = content.replace(/^```ya?ml\s*/i, '').replace(/```\s*$/i, '').trim()
        if (!content.includes('steps:')) {
          if (attempt < 2) continue
          lastError = new Error('Groq returned invalid YAML. Try recording again with fewer steps.')
          break
        }
      }
      return content
    }
  }

  // Fallback: Ollama
  const ollamaProv = fastMode ? PROVIDERS.ollama_fast : PROVIDERS.ollama
  const ollamaModel = useVision
    ? (PROVIDERS.ollama.visionModel)
    : ollamaProv.textModel
  const baseUrl = (ollamaUrl || ollamaProv.defaultUrl).replace(/\/$/, '')
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: toOllamaMessages(messages),
        stream: false
      })
    })
    if (!response.ok) throw new Error(`Ollama returned ${response.status}. Is Ollama running at ${baseUrl}?`)
    const data = await response.json()
    let content = (data.message && data.message.content || '').trim()
    if (!useVision) {
      content = content.replace(/^```ya?ml\s*/i, '').replace(/```\s*$/i, '').trim()
      if (!content.includes('steps:')) throw new Error('Ollama returned invalid YAML.')
    }
    return content
  } catch (e) {
    const claudeMsg = lastError && lastError.message.includes('Claude') ? ` Claude: ${lastError.message}` : ''
    const groqMsg = !claudeMsg && lastError ? ` Groq: ${lastError.message}` : (!groqKey ? ' No Groq API key provided.' : '')
    throw new Error(`Generation failed.${claudeMsg}${groqMsg} Ollama: ${e.message}`)
  }
}

async function generateYAML(flowName, expectedOutcome, groqKey, recording, networkLog, consoleErrors, startUrl, sessionState, fastMode) {
  const deduplicated = deduplicateRecording(recording)
  const ollamaUrl = await getStorageValue('ollamaUrl') || ''
  const MAX_STEPS = 35

  let part1Steps, part2Steps

  if (deduplicated.length > MAX_STEPS) {
    let splitIdx = MAX_STEPS
    for (let i = MAX_STEPS - 1; i > 0; i--) {
      if (deduplicated[i].action === 'navigate') {
        splitIdx = i
        break
      }
    }
    part1Steps = deduplicated.slice(0, splitIdx)
    part2Steps = deduplicated.slice(splitIdx)
  } else {
    part1Steps = deduplicated
    part2Steps = null
  }

  part1Steps = await enhanceWeakSelectorsWithVision(part1Steps, groqKey, ollamaUrl, fastMode)
  if (part2Steps) part2Steps = await enhanceWeakSelectorsWithVision(part2Steps, groqKey, ollamaUrl, fastMode)

  if (!part2Steps) {
    const prompt = buildGroqPrompt(part1Steps, networkLog, consoleErrors, flowName, expectedOutcome, startUrl, undefined, sessionState)
    const rawYaml = await callLLM([{ role: 'user', content: prompt }], false, groqKey, ollamaUrl, fastMode)
    return { yaml1: sanitizeGeneratedYaml(rawYaml), yaml2: null, isSplit: false }
  }

  const prompt1 = buildGroqPrompt(part1Steps, networkLog, consoleErrors, `${flowName} (Part 1)`, expectedOutcome, startUrl, undefined, sessionState)
  const prompt2 = buildGroqPrompt(part2Steps, networkLog, consoleErrors, `${flowName} (Part 2)`, expectedOutcome, part2Steps[0] && part2Steps[0].url || startUrl, undefined, sessionState)
  const rawYaml1 = await callLLM([{ role: 'user', content: prompt1 }], false, groqKey, ollamaUrl, fastMode)
  const rawYaml2 = await callLLM([{ role: 'user', content: prompt2 }], false, groqKey, ollamaUrl, fastMode)
  return { yaml1: sanitizeGeneratedYaml(rawYaml1), yaml2: sanitizeGeneratedYaml(rawYaml2), isSplit: true }
}

async function callLLMForSegment(events, index) {
  try {
    const prompt = buildGroqPrompt(events, '', '')
    const yaml = await callLLM(prompt)
    return yaml
  } catch(e) {
    return '# Phase ' + (index + 1) + ' failed — review manually\n'
  }
}

// ── sanitizeGeneratedYaml ─────────────────────────────────────────────────────
// Repairs common LLM mistakes in generated selectors so the output is replay-safe:
//   - [testid="x"]       → [data-testid="x"]                  (canonical form)
//   - [text="x"]         → removed (not a real CSS attribute)
//   - span#_r_1r_--label → REPLACE_WITH_ACTUAL_SELECTOR + aiDriven:true
//   - div > div > div    → REPLACE_WITH_ACTUAL_SELECTOR + aiDriven:true
//   - span[role="link"]  → removed from fallbacks (too generic)
// Also injects a waitForSelector hydration guard before form blocks when missing.

function isBadSelector(sel) {
  if (!sel || typeof sel !== 'string') return false
  const s = sel.trim()
  if (!s || s === 'REPLACE_WITH_ACTUAL_SELECTOR' || s === 'REPLACE_WITH_ACTUAL_FORM_SELECTOR') return false
  // [text="..."] — invented attribute
  if (/\[text\s*=/.test(s)) return true
  // span[role="link"] / div[role="button"] / a[role="..."] with no other discriminator
  if (/^(span|div|a|i|p)\[role\s*=\s*["'][^"']+["']\]\s*$/.test(s)) return true
  // Dynamic React id: #_r_1r_--label, #:r3:, #r1r--label
  if (/#:?[a-z]?_?r[_0-9a-z]+/i.test(s) && /_r_|:r\d|--[a-z0-9]+$/i.test(s)) return true
  // Deeply nested tag chains with no semantic anchor:
  // "div > div > div > a" — 3+ child combinators and no #id / [data-testid] / [aria-label] / [name]
  const combinators = (s.match(/>/g) || []).length
  const hasAnchor = /#[A-Za-z][\w-]*|\[(data-testid|aria-label|name|role)=/.test(s)
  if (combinators >= 2 && !hasAnchor) return true
  return false
}

// Rewrites [testid="x"] → [data-testid="x"]. Returns the corrected selector
// or null if the selector should be discarded entirely.
function repairSelector(sel) {
  if (!sel || typeof sel !== 'string') return sel
  let s = sel
  // Fix common attribute typos
  s = s.replace(/\[testid\s*=/g, '[data-testid=')
  // Strip [text="..."] entirely — it's never valid CSS
  s = s.replace(/\[text\s*=\s*["'][^"']*["']\]/g, '').trim()
  if (!s) return null
  // After stripping, reject bare tags (span, div, a, button, etc.) as primary —
  // they match too many elements to be useful.
  if (/^(span|div|a|button|input|i|p|li|ul|ol|section|article|nav|header|footer)\s*$/i.test(s)) return null
  if (isBadSelector(s)) return null
  return s
}

// Walks a YAML step block and rewrites its primary selector + fallback list.
function sanitizeStepBlock(block) {
  const lines = block.split('\n')
  let primaryIdx = -1
  let primarySelector = null
  let fallbackStart = -1
  let fallbackEnd = -1
  const fallbacks = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const selMatch = line.match(/^(\s+)selector:\s*['"]?(.+?)['"]?\s*$/)
    if (selMatch && primaryIdx === -1) {
      primaryIdx = i
      primarySelector = selMatch[2].replace(/^['"]|['"]$/g, '')
      continue
    }
    if (/^\s+fallback:\s*$/.test(line)) {
      fallbackStart = i + 1
      // Read fallback list items
      for (let j = i + 1; j < lines.length; j++) {
        const fbMatch = lines[j].match(/^\s+-\s*['"]?(.+?)['"]?\s*$/)
        if (!fbMatch) { fallbackEnd = j; break }
        fallbacks.push({ lineIdx: j, value: fbMatch[1].replace(/^['"]|['"]$/g, '') })
      }
      if (fallbackEnd === -1) fallbackEnd = lines.length
      break
    }
  }

  // Repair primary, then clean the fallback list, deduping against the new primary.
  let promotedFromFallback = null
  let finalPrimary = primarySelector

  if (primaryIdx >= 0 && primarySelector) {
    const repaired = repairSelector(primarySelector)
    if (repaired === null) {
      // Primary is unsalvageable. Promote first valid fallback if any, else use placeholder.
      const promoted = fallbacks.map(f => repairSelector(f.value)).find(Boolean)
      promotedFromFallback = promoted
      const newPrimary = promoted || 'REPLACE_WITH_ACTUAL_SELECTOR'
      lines[primaryIdx] = lines[primaryIdx].replace(/selector:\s*.*/, `selector: '${newPrimary}'`)
      finalPrimary = newPrimary
      // Insert aiDriven: true after selector line if placeholder
      if (newPrimary === 'REPLACE_WITH_ACTUAL_SELECTOR' && !block.includes('aiDriven:')) {
        const indent = (lines[primaryIdx].match(/^(\s+)/) || ['', '    '])[1]
        lines.splice(primaryIdx + 1, 0, `${indent}aiDriven: true`)
      }
    } else {
      if (repaired !== primarySelector) {
        lines[primaryIdx] = lines[primaryIdx].replace(/selector:\s*.*/, `selector: '${repaired}'`)
      }
      finalPrimary = repaired
    }
  }

  // Rebuild the fallback list: repair each entry, drop the one we promoted, dedupe against primary.
  if (fallbackStart >= 0 && fallbacks.length > 0) {
    const seen = new Set()
    if (finalPrimary) seen.add(finalPrimary)
    const cleaned = fallbacks
      .map(f => repairSelector(f.value))
      .filter(s => {
        if (!s) return false
        if (seen.has(s)) return false
        seen.add(s)
        return true
      })
    const indent = (lines[fallbacks[0].lineIdx].match(/^(\s+)-/) || ['', '      '])[1]
    const newFallbackLines = cleaned.length > 0
      ? cleaned.map(s => `${indent}- '${s}'`)
      : [`${indent}# (no valid fallbacks recorded)`]
    lines.splice(fallbackStart, fallbackEnd - fallbackStart, ...newFallbackLines)
  }

  return lines.join('\n')
}

// Renumber "# ── PHASE N: ... ──" comments sequentially from 1.
function renumberPhases(yaml) {
  let n = 0
  return yaml.replace(/(# ── PHASE )\d+(: [^─]+─+)/g, (_, prefix, suffix) => {
    n += 1
    return `${prefix}${n}${suffix}`
  })
}

// Inject a waitForSelector hydration guard before any block of type/select/check
// steps if one isn't already present in the preceding 2 steps.
function injectFormHydrationGuards(yaml) {
  const stepsIdx = yaml.indexOf('\nsteps:')
  if (stepsIdx === -1) return yaml
  const header = yaml.slice(0, stepsIdx + '\nsteps:'.length)
  const body = yaml.slice(stepsIdx + '\nsteps:'.length)
  const blocks = body.split(/\n(?=  - id:)/)

  const actionOf = (b) => (b.match(/^\s*action:\s*(\w+)/m) || [])[1]
  const selectorOf = (b) => {
    const m = b.match(/^\s*selector:\s*['"]?(.+?)['"]?\s*$/m)
    return m ? m[1].replace(/^['"]|['"]$/g, '') : ''
  }
  const idOf = (b) => ((b.match(/-\s*id:\s*(\S+)/) || [])[1] || 'step')

  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const action = actionOf(block)
    const isFormInput = action === 'type' || action === 'select' || action === 'check'

    if (isFormInput) {
      // Look back at the previous 2 emitted blocks for a waitForSelector
      const recent = out.slice(-2).map(actionOf)
      if (!recent.includes('waitForSelector')) {
        const sel = selectorOf(block)
        if (sel && sel !== 'REPLACE_WITH_ACTUAL_SELECTOR') {
          const guard = [
            `  - id: wait-for-${idOf(block).replace(/^type-|^select-|^check-/, '')}-form`,
            `    action: waitForSelector`,
            `    selector: '${sel}'`,
            `    intent: Wait for the form to hydrate before entering values`,
            `    expect: Form input is visible and interactive`,
            `    timeout: 8000`,
            `    critical: true`,
            `    continueOnFailure: false`
          ].join('\n')
          out.push(guard)
        }
      }
    }
    out.push(block)
  }
  return header + out.join('\n')
}

function sanitizeGeneratedYaml(yaml) {
  if (!yaml || typeof yaml !== 'string') return yaml
  const stepsIdx = yaml.indexOf('\nsteps:')
  if (stepsIdx === -1) return yaml

  const header = yaml.slice(0, stepsIdx + '\nsteps:'.length)
  const body = yaml.slice(stepsIdx + '\nsteps:'.length)
  // Split into step blocks, keeping leading "\n  - id:" boundary
  const blocks = body.split(/\n(?=  - id:)/)
  const sanitizedBlocks = blocks.map(b => b.includes('  - id:') ? sanitizeStepBlock(b) : b)

  let result = header + sanitizedBlocks.join('\n')
  result = injectFormHydrationGuards(result)
  result = renumberPhases(result)
  return result
}

// ── mergeYamlSegments ─────────────────────────────────────────────────────────
// Merges two or more YAML blocks into one, de-duplicating step IDs by appending
// a phase suffix (-p2, -p3, …) when the same id appears in multiple blocks.

function mergeYamlSegments(yamlBlocks) {
  if (yamlBlocks.length === 1) return yamlBlocks[0]
  const meta = yamlBlocks[0].split('steps:')[0]
  const seenIds = {}
  const allSteps = []
  yamlBlocks.forEach((block, bi) => {
    const parts = block.split('steps:')
    if (!parts[1]) return
    parts[1].split(/\n(?=  - id:)/).forEach(step => {
      if (!step.trim()) return
      const m = step.match(/- id:\s*(.+)/)
      if (m) {
        let id = m[1].trim()
        if (seenIds[id]) {
          step = step.replace(
            '- id: ' + id,
            '- id: ' + id + '-p' + (bi + 1))
        }
        seenIds[id] = true
      }
      allSteps.push(step)
    })
  })
  return meta + 'steps:\n' + allSteps.join('\n')
}

// ── YAML result warnings panel ────────────────────────────────────────────────

function parseYamlMeta(yaml) {
  const needsAttentionSteps = []
  const lines = yaml.split('\n')
  let currentStepId = null
  let currentSelector = null

  for (const line of lines) {
    const stepIdMatch = line.match(/^  - id:\s*(\S+)/)
    if (stepIdMatch) {
      currentStepId = stepIdMatch[1]
      currentSelector = null
    }
    const selectorMatch = line.match(/^\s+selector:\s*['"]?(.+?)['"]?\s*$/)
    if (selectorMatch) currentSelector = selectorMatch[1].replace(/^['"]|['"]$/g, '')

    if (currentSelector &&
        (currentSelector.includes('REPLACE_WITH_ACTUAL_SELECTOR') ||
         currentSelector.includes('REPLACE_WITH_ACTUAL_FORM_SELECTOR'))) {
      if (!needsAttentionSteps.find(s => s.id === currentStepId)) {
        needsAttentionSteps.push({ id: currentStepId, selector: currentSelector })
      }
    }
  }

  const totalSteps = (yaml.match(/^  - id:\s*\S+/gm) || []).length

  return { lowSteps: needsAttentionSteps, hasOtp: false, hasDynamic: false, hasThirdParty: false, replayableUntil: null, totalSteps }
}

function selectorWarningReason(selector) {
  if (!selector) return 'no selector — may not replay'
  if (selector.includes('REPLACE_WITH_ACTUAL_SELECTOR') ||
      selector.includes('REPLACE_WITH_ACTUAL_FORM_SELECTOR')) {
    return 'placeholder selector — must be replaced before replay'
  }
  if (selector === 'svg' || selector === 'path' || selector === 'i') {
    return `"${selector}" — too generic, may match wrong element`
  }
  if (/^#[_A-Z0-9]{6,}/.test(selector) || /^#.*[A-Z0-9]{8,}/.test(selector)) {
    return `"${selector.slice(0, 32)}..." — dynamic ID, will not replay`
  }
  return `"${selector.slice(0, 40)}" — low reliability selector`
}

function renderWarningsPanel(yaml) {
  const panel = $('warnings-panel')
  const resultSummary = $('result-summary')
  const { lowSteps, hasOtp, replayableUntil, totalSteps } = parseYamlMeta(yaml)

  const hasIssues = lowSteps.length > 0 || hasOtp
  const iconHtml = hasIssues
    ? '<span class="summary-icon">!</span>'
    : '<span class="summary-icon summary-icon-ok">✓</span>'

  const summaryParts = [`<strong>${totalSteps}</strong> steps`]
  if (lowSteps.length > 0) summaryParts.push(`<span class="summary-warn">${lowSteps.length} selector${lowSteps.length !== 1 ? 's' : ''} need attention</span>`)
  if (hasOtp) summaryParts.push('<span class="summary-warn">1 OTP detected</span>')
  if (replayableUntil) summaryParts.push(`replayable up to ${replayableUntil}`)

  resultSummary.className = 'result-summary ' + (hasIssues ? 'summary-amber' : 'summary-green')
  resultSummary.innerHTML = `${iconHtml} ${summaryParts.join(' · ')}`
  resultSummary.classList.remove('hidden')

  if (lowSteps.length === 0) {
    panel.classList.add('hidden')
    return
  }

  const items = lowSteps.map(w =>
    `<div class="warning-item"><span class="warning-step">${w.id}</span>: ${selectorWarningReason(w.selector)}</div>`
  ).join('')

  panel.innerHTML = `
    <div class="warnings-header">! ${lowSteps.length} step${lowSteps.length !== 1 ? 's' : ''} need selector attention</div>
    ${items}
  `
  panel.classList.remove('hidden')
}

// ── Inline YAML editor ────────────────────────────────────────────────────────

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let editUidCounter = 0
function makeUid() { editUidCounter += 1; return 'u' + editUidCounter }

function parseYamlSteps(yaml) {
  const steps = []
  const stepsMarker = '\nsteps:'
  const stepsIdx = yaml.indexOf(stepsMarker)
  if (stepsIdx === -1) return steps

  const afterSteps = yaml.slice(stepsIdx + stepsMarker.length)
  const parts = afterSteps.split(/(?=\n  - id:)/)

  for (let i = 0; i < parts.length; i++) {
    const block = parts[i]
    if (!block.includes('  - id:')) continue

    const getId = () => {
      const m = block.match(/\n  - id:\s*(.+)$|^  - id:\s*(.+)$/m)
      if (!m) return ''
      return (m[1] || m[2] || '').trim()
    }

    const getField = (fieldName) => {
      const re = new RegExp(`^    ${fieldName}:\\s*(.+)$`, 'm')
      const m = block.match(re)
      if (!m) return ''
      return m[1].replace(/^['"]|['"]$/g, '').trim()
    }

    const id = getId()
    if (!id) continue

    steps.push({
      uid: makeUid(),
      id,
      action: getField('action'),
      selector: getField('selector'),
      intent: getField('intent'),
      expect: getField('expect'),
      value: getField('value'),
      _block: block,
      _isNew: false
    })
  }

  return steps
}

// Per-action stub for newly-added steps. We build a complete YAML block so the
// existing field-edit machinery has something to work with. intent/expect
// placeholders are element-descriptive (where on page + appearance/role + what
// it triggers, then verifiable DOM/URL signals), so a downstream AI orchestrator
// can locate the element and confirm the outcome without seeing the site.
function buildNewStepBlock(action, idHint) {
  const id = idHint || `${action}-step`
  const common = `\n  - id: ${id}\n    action: ${action}`
  const intentHint = {
    navigate: 'A direct load of <page name> at <path>, used to skip the click-through. The destination renders <what content is primarily shown>.',
    click:    '<Visual + role description, e.g. "a primary blue submit button labeled X" / "a tab in the horizontal nav strip">, located <where — which container, which corner, beside what>. Clicking it <immediate observable effect — opens X / navigates to Y / submits Z>.',
    type:     'A <text|email|tel> input labeled "<label>" (or placeholder "<placeholder>"), located <which form, which section, which neighbouring field>. Typing into it <what part of the payload it fills>.',
    waitForSelector: '<Element description + label/role>, located <where>. Wait for it to be present, enabled, and past its mount animation so the next step does not race hydration.',
    assert:   'Verify the <previous step> produced a server-confirmed state by checking <which signal proves persistence — reference code, confirmation banner, server-rendered text>.',
    evaluate: 'Scroll <element description — e.g. "the booking form containing Firstname/Lastname/Email inputs"> into the vertical center of the viewport so <next step\'s target> is on-screen.'
  }[action] || '<Element description — where, appearance/role, what it triggers>'

  const expectHint = {
    navigate: 'URL is exactly /<route> and the page shows <heading text> with <one or two other concrete elements> visible above the fold.',
    click:    'URL contains /<path> AND <specific element or text newly visible — e.g. "a panel containing the username monishsolanki-rm and a Sign out link">; <optional what disappears>.',
    type:     'The <field> input\'s value attribute equals "<value>"; no validation error renders beneath; <adjacent field> remains visible and reachable.',
    waitForSelector: 'An element matching <selector or role + name> is present, is not disabled, has tabindex >= 0, and renders a non-zero bounding box.',
    assert:   'URL path contains /<fragment>; page body contains exact text "<text>" AND <one more concrete signal — element, count, regex>; <previous-screen element> is no longer in the DOM.',
    evaluate: '<Target element> is within the viewport (top edge 50–500px from viewport top); no scroll-triggered spinner or skeleton remains.'
  }[action] || 'URL <change>; <specific text or element newly visible that wasn\'t before>.'

  switch (action) {
    case 'navigate':
      return common +
        `\n    url: "https://example.com"` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    critical: true` +
        `\n    continueOnFailure: false`
    case 'click':
      return common +
        `\n    selector: 'REPLACE_WITH_ACTUAL_SELECTOR'` +
        `\n    aiDriven: true` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    waitAfter: 1000`
    case 'type':
      return common +
        `\n    selector: 'REPLACE_WITH_ACTUAL_SELECTOR'` +
        `\n    aiDriven: true` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    value: ""` +
        `\n    waitAfter: 300` +
        `\n    continueOnFailure: true`
    case 'waitForSelector':
      return common +
        `\n    selector: 'REPLACE_WITH_ACTUAL_SELECTOR'` +
        `\n    aiDriven: true` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    timeout: 8000` +
        `\n    critical: true` +
        `\n    continueOnFailure: false`
    case 'assert':
      return common +
        `\n    assertion:` +
        `\n      field: body` +
        `\n      operator: contains` +
        `\n      value: ""` +
        `\n    fallback_assertion:` +
        `\n      field: url` +
        `\n      operator: contains` +
        `\n      value: ""` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    continueOnFailure: true`
    case 'evaluate':
      return common +
        `\n    value: "window.scrollTo({top: 0, behavior: 'instant'})"` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}` +
        `\n    waitAfter: 500` +
        `\n    continueOnFailure: true`
    default:
      return common +
        `\n    selector: 'REPLACE_WITH_ACTUAL_SELECTOR'` +
        `\n    aiDriven: true` +
        `\n    intent: ${intentHint}` +
        `\n    expect: ${expectHint}`
  }
}

function makeNewStep(action) {
  const idHint = `${action}-step-${makeUid().slice(1)}`
  const block = buildNewStepBlock(action, idHint)
  return {
    uid: makeUid(),
    id: idHint,
    action,
    selector: ['navigate', 'evaluate', 'assert'].includes(action) ? '' : 'REPLACE_WITH_ACTUAL_SELECTOR',
    intent: '',
    expect: '',
    value: '',
    _block: block,
    _isNew: true
  }
}

function renderEditSection(yaml) {
  editParsedSteps = parseYamlSteps(yaml)
  rerenderEditCards()
}

function rerenderEditCards() {
  const container = $('edit-cards-container')
  $('edit-step-count').textContent = `${editParsedSteps.length} step${editParsedSteps.length !== 1 ? 's' : ''}`

  if (editParsedSteps.length === 0) {
    container.innerHTML = `<div style="padding:16px;text-align:center;color:#aaa;font-style:italic">No steps. <button class="edit-add-btn" data-add-at="0" style="margin-left:6px">+ Add first step</button></div>`
    return
  }

  const PLACEHOLDERS = ['REPLACE_WITH_ACTUAL_SELECTOR', 'REPLACE_WITH_ACTUAL_FORM_SELECTOR']
  const noSelectorActions = new Set(['navigate', 'evaluate', 'assert'])

  const cards = editParsedSteps.map((step, idx) => {
    const selectorNeedsAttention = PLACEHOLDERS.some(p => (step.selector || '').includes(p))
    const selectorClass = selectorNeedsAttention ? ' field-alert' : ''
    const selectorNote = selectorNeedsAttention
      ? '<span class="field-alert-note">Required — replace with actual CSS selector</span>'
      : ''

    const selectorField = noSelectorActions.has(step.action) ? '' : `
      <div class="edit-field">
        <label>selector</label>
        <input type="text" data-uid="${step.uid}" data-field="selector"
          class="${selectorClass}"
          value="${escAttr(step.selector)}"
          placeholder="CSS selector" />
        ${selectorNote}
      </div>`

    const showValue = step.value !== '' || step.action === 'type' || step.action === 'evaluate'
    const valueField = showValue ? `
      <div class="edit-field">
        <label>${step.action === 'evaluate' ? 'JS expression' : 'value'}</label>
        <input type="text" data-uid="${step.uid}" data-field="value" value="${escAttr(step.value)}" />
      </div>` : ''

    const intentText = (step.intent || '').trim()
    const intentDisplay = intentText
      ? `<span class="edit-card-intent">${escHtml(intentText)}</span>`
      : `<span class="edit-card-intent placeholder">${escHtml(step.action === 'type' ? 'Type into field' : step.action === 'click' ? 'Click element' : step.action || 'no intent')}</span>`

    const addRowBefore = idx === 0
      ? `<div class="edit-add-row"><button class="edit-add-btn" data-add-at="0">+ Add step</button></div>`
      : ''

    return `${addRowBefore}<div class="edit-card" data-uid="${step.uid}" draggable="true">
      <div class="edit-card-header">
        <span class="edit-card-drag" title="Drag to reorder">⋮⋮</span>
        <span class="edit-card-num">${idx + 1}</span>
        <span class="edit-card-action" data-action="${escAttr(step.action)}">${escHtml(step.action)}</span>
        ${intentDisplay}
        <span class="edit-card-id" title="${escAttr(step.id)}">${escHtml(step.id)}</span>
        <button class="edit-card-delete" data-delete-uid="${step.uid}" title="Delete step">×</button>
      </div>
      ${selectorField}
      <div class="edit-field">
        <label>intent</label>
        <input type="text" data-uid="${step.uid}" data-field="intent" value="${escAttr(step.intent)}" />
      </div>
      ${valueField}
      <div class="edit-field">
        <label>expect</label>
        <input type="text" data-uid="${step.uid}" data-field="expect" value="${escAttr(step.expect)}" />
      </div>
    </div>
    <div class="edit-add-row"><button class="edit-add-btn" data-add-at="${idx + 1}">+ Add step</button></div>`
  }).join('')

  container.innerHTML = cards
}

// Sync the values currently in the input fields back into editParsedSteps so
// pending edits don't get lost when the user reorders / adds / deletes.
function syncInputsToState() {
  const container = $('edit-cards-container')
  if (!container) return
  container.querySelectorAll('input[data-uid][data-field]').forEach(input => {
    const step = editParsedSteps.find(s => s.uid === input.dataset.uid)
    if (step) step[input.dataset.field] = input.value
  })
}

function openAddStepPicker(insertAt, rowEl) {
  // Replace the + button with an inline action picker
  const actions = ['navigate', 'click', 'type', 'waitForSelector', 'assert', 'evaluate']
  const picker = document.createElement('div')
  picker.className = 'edit-add-picker'
  picker.innerHTML = actions.map(a => `<button data-pick="${a}">${a}</button>`).join('') +
    `<button class="edit-add-cancel" data-pick-cancel="1">cancel</button>`
  rowEl.innerHTML = ''
  rowEl.appendChild(picker)

  picker.addEventListener('click', (e) => {
    const t = e.target
    if (t.dataset.pickCancel) {
      rerenderEditCards()
      return
    }
    const action = t.dataset.pick
    if (!action) return
    syncInputsToState()
    const newStep = makeNewStep(action)
    editParsedSteps.splice(insertAt, 0, newStep)
    rerenderEditCards()
  })
}

function deleteStep(uid) {
  syncInputsToState()
  const idx = editParsedSteps.findIndex(s => s.uid === uid)
  if (idx >= 0) {
    editParsedSteps.splice(idx, 1)
    rerenderEditCards()
  }
}

// ── Drag-to-reorder ─────────────────────────────────────────────────────
let dragSourceUid = null

function handleDragStart(e) {
  const card = e.target.closest('.edit-card')
  if (!card) return
  // Only initiate drag if the user grabbed the handle area, not an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
    e.preventDefault()
    return
  }
  dragSourceUid = card.dataset.uid
  card.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  // Firefox needs setData to start a drag
  try { e.dataTransfer.setData('text/plain', dragSourceUid) } catch (err) {}
}

function handleDragOver(e) {
  const card = e.target.closest('.edit-card')
  if (!card || card.dataset.uid === dragSourceUid) return
  e.preventDefault()
  const rect = card.getBoundingClientRect()
  const above = (e.clientY - rect.top) < rect.height / 2
  // Clear other indicators
  document.querySelectorAll('.edit-card.drop-above, .edit-card.drop-below').forEach(c => {
    if (c !== card) c.classList.remove('drop-above', 'drop-below')
  })
  card.classList.toggle('drop-above', above)
  card.classList.toggle('drop-below', !above)
}

function handleDragLeave(e) {
  const card = e.target.closest('.edit-card')
  if (card) card.classList.remove('drop-above', 'drop-below')
}

function handleDrop(e) {
  e.preventDefault()
  const card = e.target.closest('.edit-card')
  if (!card || !dragSourceUid || card.dataset.uid === dragSourceUid) return
  const rect = card.getBoundingClientRect()
  const above = (e.clientY - rect.top) < rect.height / 2
  syncInputsToState()
  const srcIdx = editParsedSteps.findIndex(s => s.uid === dragSourceUid)
  if (srcIdx === -1) return
  const [moved] = editParsedSteps.splice(srcIdx, 1)
  let targetIdx = editParsedSteps.findIndex(s => s.uid === card.dataset.uid)
  if (targetIdx === -1) targetIdx = editParsedSteps.length
  if (!above) targetIdx += 1
  editParsedSteps.splice(targetIdx, 0, moved)
  rerenderEditCards()
}

function handleDragEnd() {
  document.querySelectorAll('.edit-card.dragging, .edit-card.drop-above, .edit-card.drop-below')
    .forEach(c => c.classList.remove('dragging', 'drop-above', 'drop-below'))
  dragSourceUid = null
}

function applyFieldToBlock(block, fieldName, newVal, quoteChar) {
  // Use [ \t]* (horizontal whitespace only) so the match doesn't cross newlines
  // and eat the next field's line.
  const re = new RegExp(`(^    ${fieldName}:[ \\t]*)(.*)$`, 'm')
  if (!re.test(block)) return block
  const val = quoteChar ? `${quoteChar}${newVal}${quoteChar}` : newVal
  return block.replace(re, `$1${val}`)
}

function reconstructYamlFromEdits(originalYaml, steps) {
  const stepsMarker = '\nsteps:'
  const stepsIdx = originalYaml.indexOf(stepsMarker)
  const header = stepsIdx !== -1
    ? originalYaml.slice(0, stepsIdx + stepsMarker.length)
    : ''

  const stepsContent = '\n\n' + steps.map(step => {
    // For newly-added steps, regenerate the block from the chosen action
    // template using the current id, so a fresh insert renders with all required
    // scaffolding (selector, fallback hint, waitAfter, etc.).
    let block = step._isNew
      ? buildNewStepBlock(step.action, step.id || `${step.action}-step`)
      : step._block
    block = block.replace(/^\n+/, '')
    // Always update the id, in case the user renamed it
    block = block.replace(/(^  - id:\s*)(.+)$/m, `$1${step.id}`)
    block = applyFieldToBlock(block, 'selector', step.selector, "'")
    block = applyFieldToBlock(block, 'intent', step.intent, '')
    block = applyFieldToBlock(block, 'expect', step.expect, '')
    if (step.value !== undefined && step.value !== '') {
      const quote = step.action === 'evaluate' ? '"' : '"'
      block = applyFieldToBlock(block, 'value', step.value, quote)
    }
    return block
  }).join('\n\n') + '\n'

  return header + stepsContent
}

async function handleStopResponse(res) {
  currentRecording = res && res.recording || []
  currentNetworkLog = res && res.networkLog || []
  currentConsoleErrors = res && res.consoleErrors || []
  currentSessionState = (res && res.sessionState) || null
  if (res && res.startUrl) startUrl = res.startUrl
  renderStepsList(currentRecording)
  showSection('review')
}

// ── Init ──────────────────────────────────────────────────────────────────────

;(async () => {
  const stored = await chrome.storage.local.get(['groqKey', 'ollamaUrl', 'claudeApiKey'])
  if (stored.groqKey) $('groq-key').value = stored.groqKey
  if (stored.ollamaUrl) $('ollama-url').value = stored.ollamaUrl
  if (stored.claudeApiKey) $('claude-key').value = stored.claudeApiKey

  const state = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_RECORDING' }, resolve)
  )

  if (state && state.isRecording) {
    showSection('recording')
    updatePreview(state.recording || [])
    startPoll()
  } else {
    showSection('idle')
  }
})()

// ── Button handlers ───────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', async () => {
  phaseNumber = 1
  chrome.storage.session.remove('previousYaml')
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  startUrl = tabs[0] && tabs[0].url || ''
  await chrome.runtime.sendMessage({ type: 'START_RECORDING' })
  showSection('recording')
  $('step-count').textContent = '0 steps'
  $('preview-list').innerHTML = '<li class="preview-empty">Waiting for interactions...</li>'
  const badge = $('phase-badge')
  if (badge) badge.style.display = 'none'
  startPoll()
})

$('btn-stop').addEventListener('click', async () => {
  stopPoll()
  const res = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, resolve)
  )
  await handleStopResponse(res)
})

$('btn-rerecord').addEventListener('click', async () => {
  phaseNumber = 1
  chrome.storage.session.remove('previousYaml')
  await chrome.runtime.sendMessage({ type: 'CLEAR_RECORDING' })
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  startUrl = tabs[0] && tabs[0].url || ''
  await chrome.runtime.sendMessage({ type: 'START_RECORDING' })
  $('step-count').textContent = '0 steps'
  $('preview-list').innerHTML = '<li class="preview-empty">Waiting for interactions...</li>'
  const badge = $('phase-badge')
  if (badge) badge.style.display = 'none'
  showSection('recording')
  startPoll()
})

$('btn-generate').addEventListener('click', async () => {
  const flowName = $('flow-name').value.trim()
  const expectedOutcome = $('expected-outcome').value.trim()
  const groqKey = $('groq-key').value.trim()
  const claudeKey = $('claude-key').value.trim()
  const ollamaUrl = $('ollama-url').value.trim()
  const fastMode = $('fast-mode').checked

  if (!flowName) { alert('Please enter a flow name.'); return }
  if (!expectedOutcome) { alert('Please describe the expected outcome.'); return }
  if (currentRecording.length === 0) { alert('No steps recorded. Please re-record.'); return }

  await chrome.storage.local.set({ groqKey, ollamaUrl, claudeApiKey: claudeKey })
  currentFlowName = flowName

  showSection('generating')

  try {
    const result = await generateYAML(
      flowName, expectedOutcome, groqKey,
      currentRecording, currentNetworkLog, currentConsoleErrors,
      startUrl, currentSessionState, fastMode
    )
    let newYaml = result.yaml1
    generatedYaml2 = result.yaml2 || ''
    isSplitYaml = result.isSplit

    // ── Phase merge check ───────────────────────────────────────────────────
    // If a previous phase's YAML was saved, merge it with the new YAML now,
    // before showing the edit cards to the user.
    const { previousYaml } = await chrome.storage.session.get('previousYaml')
    if (previousYaml) {
      newYaml = mergeYamlSegments([previousYaml, newYaml])
      // Re-sanitize after merge so phase numbering is global across segments.
      newYaml = sanitizeGeneratedYaml(newYaml)
      await chrome.storage.session.remove('previousYaml')
    }

    generatedYaml = newYaml
    renderEditSection(generatedYaml)
    showSection('edit')
  } catch (err) {
    $('error-message').textContent = err.message || 'Failed to generate YAML.'
    showSection('error')
  }
})

// ── Editor delegation: add / delete / drag ──────────────────────────────
;(() => {
  const container = $('edit-cards-container')
  if (!container) return

  container.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.edit-add-btn')
    if (addBtn) {
      syncInputsToState()
      const insertAt = parseInt(addBtn.dataset.addAt, 10)
      const row = addBtn.closest('.edit-add-row') || addBtn.parentElement
      // Wrap a one-off picker into the row (preserves layout when canceled)
      const tempRow = document.createElement('div')
      tempRow.className = 'edit-add-row'
      row.replaceWith(tempRow)
      openAddStepPicker(insertAt, tempRow)
      return
    }
    const delBtn = e.target.closest('.edit-card-delete')
    if (delBtn) {
      deleteStep(delBtn.dataset.deleteUid)
      return
    }
  })

  container.addEventListener('dragstart', handleDragStart)
  container.addEventListener('dragover', handleDragOver)
  container.addEventListener('dragleave', handleDragLeave)
  container.addEventListener('drop', handleDrop)
  container.addEventListener('dragend', handleDragEnd)
})()

$('btn-confirm-edit').addEventListener('click', () => {
  syncInputsToState()

  generatedYaml = reconstructYamlFromEdits(generatedYaml, editParsedSteps)
  $('yaml-preview').textContent = generatedYaml
  renderWarningsPanel(generatedYaml)

  if (isSplitYaml) {
    $('btn-download').classList.add('hidden')
    $('btn-row-split').classList.remove('hidden')
  } else {
    $('btn-download').classList.remove('hidden')
    $('btn-row-split').classList.add('hidden')
  }
  showSection('result')
})

$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(generatedYaml)
  const btn = $('btn-copy')
  const original = btn.textContent
  btn.textContent = 'Copied!'
  setTimeout(() => { btn.textContent = original }, 2000)
})

$('btn-download').addEventListener('click', () => {
  const slug = currentFlowName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const filename = `${slug || 'flow'}.yaml`
  const blob = new Blob([generatedYaml], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
})

$('btn-download-part1').addEventListener('click', () => {
  const slug = currentFlowName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const blob = new Blob([generatedYaml], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug || 'flow'}-part1.yaml`
  a.click()
  URL.revokeObjectURL(url)
})

$('btn-download-part2').addEventListener('click', () => {
  const slug = currentFlowName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const blob = new Blob([generatedYaml2], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug || 'flow'}-part2.yaml`
  a.click()
  URL.revokeObjectURL(url)
})

// ── Record Next Phase ─────────────────────────────────────────────────────────
// Saves the current YAML, increments the phase counter, resets the recorder,
// and transitions back to recording for the next phase.

$('btn-record-next-phase').addEventListener('click', async () => {
  // Save current YAML so it can be merged after the next phase generates
  await chrome.storage.session.set({ previousYaml: generatedYaml })

  phaseNumber++

  // Show phase badge in the recording section
  const badge = $('phase-badge')
  if (badge) {
    badge.textContent = 'Phase ' + phaseNumber + ' — will merge with previous flow'
    badge.style.display = 'block'
  }

  // Reset recording state in background (clears segments, starts fresh)
  await chrome.runtime.sendMessage({ type: 'START_RECORDING' })

  // Reset recording UI
  $('step-count').textContent = '0 steps'
  $('preview-list').innerHTML = '<li class="preview-empty">Waiting for interactions...</li>'

  showSection('recording')
  startPoll()
})

$('btn-another').addEventListener('click', async e => {
  e.preventDefault()
  phaseNumber = 1
  chrome.storage.session.remove('previousYaml')
  await chrome.runtime.sendMessage({ type: 'CLEAR_RECORDING' })
  currentRecording = []
  currentNetworkLog = []
  currentConsoleErrors = []
  generatedYaml = ''
  generatedYaml2 = ''
  currentFlowName = ''
  currentSessionState = null
  isSplitYaml = false
  editParsedSteps = []
  $('flow-name').value = ''
  $('expected-outcome').value = ''
  $('btn-download').classList.remove('hidden')
  $('btn-row-split').classList.add('hidden')
  showSection('idle')
})

$('btn-try-again').addEventListener('click', () => {
  showSection('review')
})