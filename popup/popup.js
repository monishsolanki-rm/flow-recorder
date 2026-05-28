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

function describeAction(event, i) {
  const el = event.element
  const elDesc = el ? [
    el.testid        ? `testid="${el.testid}"`            : '',
    el.id            ? `id="${el.id}"`                    : '',
    el.ariaLabel     ? `aria-label="${el.ariaLabel}"`      : '',
    el.text          ? `text="${el.text.slice(0, 80)}"`   : '',
    el.placeholder   ? `placeholder="${el.placeholder}"`  : '',
    el.nearbyLabel   ? `label="${el.nearbyLabel}"`        : '',
    el.nearbyHeading ? `heading="${el.nearbyHeading}"`    : '',
    el.formContext   ? `form="${el.formContext}"`          : '',
    el.sectionContext ? `section="${el.sectionContext}"`  : '',
    el.tagPath       ? `path="${el.tagPath}"`             : '',
    el.inShadowDOM   ? 'shadow-dom=true'                  : '',
    el.isDisabled    ? 'disabled=true'                    : ''
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
    intent: Plain English description of what page to load
    expect: What should be visible after navigation
    critical: true
    continueOnFailure: false

TYPE:
  - id: type-fieldname
    action: type
    selector: 'CSS selector'
    fallback:
      - 'fallback selector 1'
      - 'fallback selector 2'
    intent: Enter [value] in the [field name] input field
    expect: Field shows [value]
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
    intent: Click the [element description]
    expect: What changes after click
    waitAfter: 1000
    critical: true
    continueOnFailure: false

EVALUATE (use for scrolling — never use raw scroll steps):
  - id: scroll-to-section
    action: evaluate
    value: "document.getElementById('sectionId')?.scrollIntoView({behavior:'instant',block:'center'})"
    intent: Scroll to the [section name] section
    expect: [Target content] is visible
    waitAfter: 500
    continueOnFailure: true

WAITFORSELECTOR:
  - id: wait-for-form
    action: waitForSelector
    selector: 'CSS selector or REPLACE_WITH_ACTUAL_FORM_SELECTOR'
    fallback:
      - 'form'
      - 'input'
    intent: Wait for [element name] to be visible and interactive
    expect: [Element] is visible and interactable
    timeout: 10000
    continueOnFailure: true

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
    intent: Verify that [what] happened
    expect: Page shows [expected confirmation content]
    continueOnFailure: true

────────────────────────────────────────────
RULES — follow every rule exactly
────────────────────────────────────────────

── SELECTORS ────────────────────────────────

Priority order — use first available:
  1. [data-testid="value"]
  2. #id (skip if looks auto-generated: 8+ random chars)
  3. [aria-label="value"]
  4. [name="value"]
  5. input[type="x"] or button.specific-class
  6. If unknown or unverifiable: REPLACE_WITH_ACTUAL_SELECTOR

Always include 2-3 fallback selectors.
Never use bare tag names (button, a, div), nth-child, or hashed/generated classes.
selector must always be valid CSS or REPLACE_WITH_ACTUAL_SELECTOR.

── SCROLLING ────────────────────────────────

Always use evaluate action with scrollIntoView — never output raw pixel scroll steps.
Use: document.getElementById('sectionId')?.scrollIntoView({behavior:'instant',block:'center'})
Or:  window.scrollTo({top: 0, behavior: 'instant'}) to scroll to top.

── STEP IDS ─────────────────────────────────

Step IDs must be kebab-case, descriptive, and unique.
Good: navigate-home, click-check-availability, type-firstname, assert-confirmed
Bad: step_1, step1, step-1

── CRITICAL STEPS ───────────────────────────

Set critical: true and continueOnFailure: false for steps that block the entire flow:
  - Initial navigation to the start URL
  - Search / availability check buttons
  - Book / proceed / reserve buttons
  - Form submission
All other steps: continueOnFailure: true, omit critical field.

── UNKNOWN SELECTORS ────────────────────────

When the exact selector cannot be determined from the recording, use:
  selector: 'REPLACE_WITH_ACTUAL_SELECTOR'
and provide strong fallback selectors so the runner can still attempt the step.

── PHASE COMMENTS ───────────────────────────

Group related steps with YAML comments:
  # ── PHASE 1: Navigation ──────────────────────
  # ── PHASE 2: Form Filling ────────────────────

── waitAfter ────────────────────────────────

Include waitAfter only when the app genuinely needs time to respond:
  - After click that triggers navigation or data load: 1000-3000ms
  - After type into a date/search field: 300-500ms
  - After evaluate scroll: 500-800ms
Omit waitAfter on simple clicks and asserts.

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
    const yaml1 = await callLLM([{ role: 'user', content: prompt }], false, groqKey, ollamaUrl, fastMode)
    return { yaml1, yaml2: null, isSplit: false }
  }

  const prompt1 = buildGroqPrompt(part1Steps, networkLog, consoleErrors, `${flowName} (Part 1)`, expectedOutcome, startUrl, undefined, sessionState)
  const prompt2 = buildGroqPrompt(part2Steps, networkLog, consoleErrors, `${flowName} (Part 2)`, expectedOutcome, part2Steps[0] && part2Steps[0].url || startUrl, undefined, sessionState)
  const yaml1 = await callLLM([{ role: 'user', content: prompt1 }], false, groqKey, ollamaUrl, fastMode)
  const yaml2 = await callLLM([{ role: 'user', content: prompt2 }], false, groqKey, ollamaUrl, fastMode)
  return { yaml1, yaml2, isSplit: true }
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
      id,
      action: getField('action'),
      selector: getField('selector'),
      intent: getField('intent'),
      expect: getField('expect'),
      value: getField('value'),
      _block: block
    })
  }

  return steps
}

function renderEditSection(yaml) {
  editParsedSteps = parseYamlSteps(yaml)
  const container = $('edit-cards-container')
  $('edit-step-count').textContent = `${editParsedSteps.length} step${editParsedSteps.length !== 1 ? 's' : ''}`

  if (editParsedSteps.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:#aaa;font-style:italic">No steps found. Proceeding to result.</div>'
    return
  }

  const PLACEHOLDERS = ['REPLACE_WITH_ACTUAL_SELECTOR', 'REPLACE_WITH_ACTUAL_FORM_SELECTOR']
  const noSelectorActions = new Set(['navigate', 'evaluate', 'assert'])

  container.innerHTML = editParsedSteps.map((step, idx) => {
    const selectorNeedsAttention = PLACEHOLDERS.some(p => step.selector.includes(p))
    const selectorClass = selectorNeedsAttention ? ' field-alert' : ''
    const selectorNote = selectorNeedsAttention
      ? '<span class="field-alert-note">Required — replace with actual CSS selector</span>'
      : ''

    const selectorField = noSelectorActions.has(step.action) ? '' : `
      <div class="edit-field">
        <label>selector</label>
        <input type="text" data-idx="${idx}" data-field="selector"
          class="${selectorClass}"
          value="${escAttr(step.selector)}"
          placeholder="CSS selector" />
        ${selectorNote}
      </div>`

    const valueField = step.value ? `
      <div class="edit-field">
        <label>value</label>
        <input type="text" data-idx="${idx}" data-field="value" value="${escAttr(step.value)}" />
      </div>` : ''

    return `<div class="edit-card">
      <div class="edit-card-header">
        <span class="edit-card-id">${escHtml(step.id)}</span>
        <span class="edit-card-action">${escHtml(step.action)}</span>
      </div>
      ${selectorField}
      <div class="edit-field">
        <label>intent</label>
        <input type="text" data-idx="${idx}" data-field="intent" value="${escAttr(step.intent)}" />
      </div>
      ${valueField}
      <div class="edit-field">
        <label>expect</label>
        <input type="text" data-idx="${idx}" data-field="expect" value="${escAttr(step.expect)}" />
      </div>
    </div>`
  }).join('')
}

function applyFieldToBlock(block, fieldName, newVal, quoteChar) {
  const re = new RegExp(`(^    ${fieldName}:\\s*)(.*)$`, 'm')
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
    let block = step._block.replace(/^\n+/, '')
    block = applyFieldToBlock(block, 'selector', step.selector, "'")
    block = applyFieldToBlock(block, 'intent', step.intent, '')
    block = applyFieldToBlock(block, 'expect', step.expect, '')
    if (step.value) block = applyFieldToBlock(block, 'value', step.value, '"')
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

$('btn-confirm-edit').addEventListener('click', () => {
  const container = $('edit-cards-container')
  container.querySelectorAll('input[data-field]').forEach(input => {
    const idx = parseInt(input.dataset.idx)
    const field = input.dataset.field
    if (editParsedSteps[idx]) editParsedSteps[idx][field] = input.value
  })

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