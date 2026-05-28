// CDP-based recording via chrome.debugger — multi-tab, unified frontend+network capture

let isRecording = false
let recording = []
let networkLog = []     // residual unlinked network entries, drained at stop
let consoleLog = []     // rolling console errors, collected per-event
let recordingTabs = new Set()
let startUrl = ''
let lastNavigateUrl = ''
let recordingMetadata = {}
let segments = []
let currentSegmentIndex = 0

// Per-request network buffers — keyed by CDP requestId
const networkBuffer = new Map()   // requestId → { method, url, request_headers, request_body, startTime, wallTime }
const responseBuffer = new Map()  // requestId → { response_status, response_headers, response_body, timing_ms, redirected, mimeType }

// How long to wait after an action for network to settle before linking
const NETWORK_FLUSH_MS = 2000

// Restore state on service-worker wake
const initPromise = chrome.storage.session
  .get(['isRecording', 'recording', 'networkLog', 'consoleLog', 'startUrl', 'lastNavigateUrl', 'recordingTabIds', 'recordingMetadata'])
  .then(data => {
    isRecording = data.isRecording || false
    recording = data.recording || []
    networkLog = data.networkLog || []
    consoleLog = data.consoleLog || []
    startUrl = data.startUrl || ''
    lastNavigateUrl = data.lastNavigateUrl || ''
    if (data.recordingTabIds) recordingTabs = new Set(data.recordingTabIds)
    recordingMetadata = data.recordingMetadata || {}
  })

async function saveState() {
  await chrome.storage.session.set({
    isRecording, recording, networkLog, consoleLog,
    startUrl, lastNavigateUrl, recordingTabIds: [...recordingTabs], recordingMetadata
  })
}

// ── CDP helpers ───────────────────────────────────────────────────────────────

async function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return }
      resolve()
    })
  })
}

function detachDebugger(tabId) {
  chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError })
}

async function sendCDP(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError)
      else resolve(result || {})
    })
  })
}

// ── Screenshot — saved locally only, NOT sent to Groq ────────────────────────

async function captureScreenshot(tabId) {
  try {
    const result = await sendCDP(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    return result.data || null
  } catch {
    return null
  }
}

// ── URL utilities ─────────────────────────────────────────────────────────────

function cleanUrl(url) {
  try {
    const u = new URL(url)
    const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
      'utm_content', 'gclid', 'fbclid', 'ref', 'source', '_ga']
    TRACKING.forEach(p => u.searchParams.delete(p))
    return u.toString()
  } catch {
    return url
  }
}

// ── Session state capture ─────────────────────────────────────────────────────

async function captureSessionState(tabId) {
  if (!tabId) return { authenticated: false }
  try {
    const result = await sendCDP(tabId, 'Runtime.evaluate', {
      expression: `({
        hasAuthCookie: document.cookie.split(';').some(c =>
          ['session','token','auth','jwt','sid'].some(k =>
            c.trim().toLowerCase().startsWith(k)
          )
        ),
        hasAuthStorage: Object.keys(localStorage).some(k =>
          ['token','auth','session','user','jwt'].some(kw =>
            k.toLowerCase().includes(kw)
          )
        )
      })`,
      returnByValue: true
    })
    const val = result && result.result && result.result.value || {}
    return {
      authenticated: !!(val.hasAuthCookie || val.hasAuthStorage),
      restored_from_existing_cookie: !!val.hasAuthCookie
    }
  } catch {
    return { authenticated: false }
  }
}

// ── Navigate classification ───────────────────────────────────────────────────

function classifyNavigation(event, previousEvent) {
  if (!previousEvent) return 'user_action'

  const timeSincePrev = (event.timestamp || Date.now()) - (previousEvent.timestamp || 0)

  if (['click', 'submit'].includes(previousEvent.action) && timeSincePrev < 1500) {
    return 'user_action'
  }

  if (timeSincePrev < 300) {
    const url = (event.url || '').toLowerCase()
    const prevUrl = (previousEvent.url || '').toLowerCase()
    const isAuthRelated = url.includes('login') || url.includes('auth') ||
      url.includes('callback') || url.includes('redirect') || url.includes('oauth') ||
      prevUrl.includes('login')
    return isAuthRelated ? 'auth_redirect' : 'system_redirect'
  }

  return 'user_action'
}

// ── Network helpers ───────────────────────────────────────────────────────────

const STATIC_EXTENSIONS = ['.js', '.css', '.woff', '.woff2', '.ttf',
  '.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif', '.map']

function isApiCall(url, mimeType) {
  if (STATIC_EXTENSIONS.some(ext => url.split('?')[0].endsWith(ext))) return false
  if (mimeType && mimeType.startsWith('image/')) return false
  if (mimeType && mimeType.startsWith('font/')) return false
  return true
}

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-auth-token',
  'x-api-key', 'x-session-id', 'x-csrf-token'
])

function sanitiseHeaders(headers) {
  if (!headers) return {}
  const result = {}
  for (const [key, val] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '***' : val
  }
  return result
}

function truncateBody(body) {
  if (!body) return null
  if (body.length > 2000) return body.slice(0, 2000) + '... [truncated]'
  return body
}

// ── Console collection — per-event ────────────────────────────────────────────

function collectConsoleSince(timestamp) {
  const errors = consoleLog.filter(e => e.timestamp >= timestamp)
  const lastOldIdx = consoleLog.findLastIndex(e => e.timestamp < timestamp)
  if (lastOldIdx >= 0) consoleLog.splice(0, lastOldIdx + 1)
  return errors
}

// ── Tab initialization ────────────────────────────────────────────────────────

async function initTab(tabId) {
  if (recordingTabs.has(tabId)) return
  recordingTabs.add(tabId)
  await saveState()

  try {
    await attachDebugger(tabId)
    await sendCDP(tabId, 'Page.enable')
    await sendCDP(tabId, 'Network.enable')
    await sendCDP(tabId, 'DOM.enable')
    await sendCDP(tabId, 'Runtime.enable')
    await sendCDP(tabId, 'Network.setCacheDisabled', { cacheDisabled: true })
    await injectEventCapture(tabId)
  } catch (err) {
    console.error('Failed to init tab', tabId, err)
    recordingTabs.delete(tabId)
    await saveState()
  }
}

// ── Start recording ───────────────────────────────────────────────────────────

async function startRecording(tabId, url) {
  isRecording = true
  recording = []
  networkLog = []
  consoleLog = []
  networkBuffer.clear()
  responseBuffer.clear()
  recordingTabs = new Set()
  recordingMetadata = {}
  startUrl = cleanUrl(url)
  lastNavigateUrl = ''

  await initTab(tabId)
  recordingMetadata = await captureSessionState(tabId)
  await saveState()
}

// ── Cross-tab following ───────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await initPromise
  if (!isRecording) return
  if (changeInfo.status !== 'complete') return
  if (!tab.url || tab.url.startsWith('chrome://')) return

  if (!recordingTabs.has(tabId)) {
    const lastEvent = recording[recording.length - 1]
    const eventType = classifyNavigation({ url: cleanUrl(tab.url), timestamp: Date.now() }, lastEvent)
    recording.push({
      action: 'navigate',
      event_type: eventType,
      url: cleanUrl(tab.url),
      new_tab: true,
      timestamp: Date.now(),
      network: [],
      console_errors: []
    })
    try { chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATE', count: recording.length, segmentIndex: currentSegmentIndex }) } catch(e) {}
  }

  await initTab(tabId)
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await initPromise
  if (!isRecording) return
  if (recordingTabs.has(tabId)) return

  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url || tab.url.startsWith('chrome://')) return
    await initTab(tabId)
  } catch {
    // Tab may have closed
  }
})

// ── CDP event listener ────────────────────────────────────────────────────────

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await initPromise
  const tabId = source.tabId
  if (!isRecording || !recordingTabs.has(tabId)) return

  switch (method) {

    case 'Page.frameNavigated': {
      if (params.frame.parentId) return
      const url = params.frame.url
      if (url === lastNavigateUrl) return
      if (url.startsWith('chrome://') || url === 'about:blank') return
      lastNavigateUrl = url

      if (!startUrl) startUrl = cleanUrl(url)

      const lastEvent = recording[recording.length - 1]
      const eventType = classifyNavigation({ url: cleanUrl(url), timestamp: Date.now() }, lastEvent)
      recording.push({
        action: 'navigate',
        event_type: eventType,
        url: cleanUrl(url),
        spa: false,
        timestamp: Date.now(),
        network: [],
        console_errors: []
      })
      try { chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATE', count: recording.length, segmentIndex: currentSegmentIndex }) } catch(e) {}
      await saveState()
      setTimeout(() => injectEventCapture(tabId), 800)
      break
    }

    case 'Network.requestWillBeSent':
      networkBuffer.set(params.requestId, {
        method: params.request.method,
        url: params.request.url,
        request_headers: params.request.headers,
        request_body: params.request.postData || null,
        startTime: params.timestamp,    // CDP monotonic seconds
        wallTime: Date.now()            // wall clock ms — used for action attribution
      })
      break

    case 'Network.responseReceived': {
      const req = networkBuffer.get(params.requestId)
      if (!req) break
      responseBuffer.set(params.requestId, {
        response_status: params.response.status,
        response_headers: params.response.headers,
        timing_ms: Math.round((params.timestamp - req.startTime) * 1000),
        redirected: params.response.status >= 300 && params.response.status < 400,
        mimeType: params.response.mimeType || '',
        response_body: null
      })
      break
    }

    case 'Network.loadingFinished': {
      const res = responseBuffer.get(params.requestId)
      if (!res) break
      try {
        const body = await sendCDP(tabId, 'Network.getResponseBody', { requestId: params.requestId })
        res.response_body = body.body || null
      } catch { }
      break
    }

    case 'Network.loadingFailed': {
      const req = networkBuffer.get(params.requestId)
      if (!req) break
      responseBuffer.set(params.requestId, {
        response_status: 0,
        response_headers: {},
        timing_ms: Math.round((params.timestamp - req.startTime) * 1000),
        redirected: false,
        mimeType: '',
        response_body: null,
        error: params.errorText
      })
      break
    }

    case 'Runtime.consoleAPICalled':
      if (['error', 'warn'].includes(params.type)) {
        consoleLog.push({
          type: params.type,
          text: params.args?.map(a => a.value || a.description || '').join(' '),
          timestamp: Date.now()
        })
      }
      break

    case 'Network.webSocketCreated':
      recording.push({
        action: 'websocket_opened',
        event_type: 'user_action',
        url: params.url,
        timestamp: Date.now(),
        network: [],
        console_errors: []
      })
      try { chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATE', count: recording.length, segmentIndex: currentSegmentIndex }) } catch(e) {}
      break

    case 'Network.webSocketFrameSent': {
      const last = recording[recording.length - 1]
      if (last) {
        last.websocket_sent = last.websocket_sent || []
        last.websocket_sent.push({
          payload: params.response?.payloadData?.slice(0, 500)
        })
      }
      break
    }

    case 'Network.webSocketFrameReceived': {
      const last = recording[recording.length - 1]
      if (last) {
        last.websocket_received = last.websocket_received || []
        last.websocket_received.push({
          payload: params.response?.payloadData?.slice(0, 500)
        })
      }
      break
    }
  }
})

chrome.debugger.onDetach.addListener(async source => {
  await initPromise
  if (isRecording && recordingTabs.has(source.tabId)) {
    recordingTabs.delete(source.tabId)
    await saveState()
  }
})

// ── Event processing — unified frontend + network ─────────────────────────────

// Actions that may trigger network — apply the flush window before linking
const NETWORK_ACTIONS = new Set([
  'click', 'dblclick', 'drag', 'submit', 'navigate', 'select', 'check', 'uncheck', 'keypress'
])

function shouldTakeScreenshot(event, recording) {
  if (recording.length === 0) return true
  if (event.action === 'navigate') return true
  if (event.network && event.network.some(n => n.response_status >= 400)) return true
  if (event.console_errors && event.console_errors.length > 0) return true
  if (event.action === 'submit') return true
  if (event.action === 'drag') return true
  if (event.action === 'click' && event.network && event.network.length > 0) return true
  return false
}

function groupIntoBusinessSteps(events) {
  const groups = []
  let formGroup = null

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    if (event.action === 'focus') continue

    if (event.action === 'click' && groups.length > 0) {
      const lastGroup = groups[groups.length - 1]
      const lastEv = lastGroup && lastGroup.events && lastGroup.events[lastGroup.events.length - 1]
      if (lastEv && lastEv.action === 'click' &&
          lastEv.element && event.element &&
          lastEv.element.id === event.element.id &&
          lastEv.element.testid === event.element.testid &&
          lastEv.element.text === event.element.text &&
          event.timestamp - lastEv.timestamp < 3000) continue
    }

    const sameElementCount = events.slice(Math.max(0, i - 5), i).filter(e =>
      e.action === 'click' && e.element && event.element &&
      e.element.id === event.element.id &&
      e.element.tagPath === event.element.tagPath
    ).length
    if (sameElementCount >= 3) {
      event.manual_replay = true
      event.note = 'Editor interaction — cannot be automated reliably'
    }

    if (event.action === 'navigate') {
      if (formGroup) { groups.push(formGroup); formGroup = null }
      groups.push({ type: 'navigation', events: [event] })
      continue
    }

    if (['type', 'select', 'check', 'uncheck'].includes(event.action)) {
      if (!formGroup) formGroup = { type: 'form_fill', events: [] }
      const sel = event.element && (event.element.id || event.element.name ||
        event.element.placeholder || event.element.testid)
      if (sel) {
        const existingIdx = formGroup.events.findIndex(e =>
          e.element && (e.element.id || e.element.name ||
            e.element.placeholder || e.element.testid) === sel
        )
        if (existingIdx >= 0) formGroup.events[existingIdx] = event
        else formGroup.events.push(event)
      } else {
        formGroup.events.push(event)
      }
      continue
    }

    if (event.action === 'submit' ||
        (event.action === 'click' && event.network && event.network.length > 0)) {
      if (formGroup) { groups.push(formGroup); formGroup = null }
      groups.push({ type: 'action', events: [event] })
      continue
    }

    if (formGroup) { groups.push(formGroup); formGroup = null }
    groups.push({ type: 'interaction', events: [event] })
  }

  if (formGroup) groups.push(formGroup)

  return groups.flatMap(g => g.events.map(e => ({ ...e, business_group: g.type })))
}

async function processEvent(event, tabId) {
  const actionStart = Date.now()

  // ── Deduplication ─────────────────────────────────────────────────────────

  if (event.action === 'navigate') {
    const clean = cleanUrl(event.url)
    if (clean === lastNavigateUrl) return
    lastNavigateUrl = clean
    event.url = clean

    // Click already implies navigation — skip the redundant navigate event
    if (recording.length > 0) {
      const last = recording[recording.length - 1]
      if (last.action === 'click' && Date.now() - last.timestamp < 2000) return
    }

    const lastEvent = recording[recording.length - 1]
    event.event_type = classifyNavigation(event, lastEvent)
  }

  if (event.action === 'click' && recording.length > 0) {
    const last = recording[recording.length - 1]
    if (last.action === 'click' &&
        last.element?.testid === event.element?.testid &&
        last.element?.text === event.element?.text &&
        event.timestamp - last.timestamp < 800) {
      return
    }
  }

  // ── Screenshot — selective capture based on event significance ──────────────

  if (tabId && shouldTakeScreenshot(event, recording)) {
    await new Promise(r => setTimeout(r, 300))
    event.screenshot = await captureScreenshot(tabId)
  }

  // ── Network flush — wait for requests triggered by this action to settle ──

  if (NETWORK_ACTIONS.has(event.action)) {
    await new Promise(r => setTimeout(r, NETWORK_FLUSH_MS))
  }

  // ── Link network activity to this event ───────────────────────────────────

  const linkedNetwork = []

  if (NETWORK_ACTIONS.has(event.action)) {
    for (const [requestId, req] of networkBuffer.entries()) {
      // Only requests that started after this action began
      if (req.wallTime < actionStart) continue
      const res = responseBuffer.get(requestId)
      // Skip if response hasn't arrived yet (still in flight)
      if (!res) continue
      // Skip static assets — API calls and document requests only
      if (!isApiCall(req.url, res.mimeType)) continue

      linkedNetwork.push({
        method: req.method,
        url: req.url,
        request_headers: sanitiseHeaders(req.request_headers),
        request_body: req.request_body,
        response_status: res.response_status,
        response_body: truncateBody(res.response_body),
        response_headers: sanitiseHeaders(res.response_headers),
        timing_ms: res.timing_ms,
        redirected: res.redirected
      })

      // Remove once linked so a subsequent action doesn't claim the same request
      networkBuffer.delete(requestId)
      responseBuffer.delete(requestId)
    }
  }

  event.network = linkedNetwork
  event.console_errors = collectConsoleSince(actionStart)

  if (!event.event_type) event.event_type = 'user_action'
  recording.push(event)
  try { chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATE', count: recording.length, segmentIndex: currentSegmentIndex }) } catch(e) {}
  await saveState()
}

// ── Event capture injection ───────────────────────────────────────────────────

async function injectEventCapture(tabId) {
  const script = `
(function() {
  if (window.__flowRecorderV2) return
  window.__flowRecorderV2 = true

  function getNearbyLabel(el) {
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]')
      if (label) return label.innerText && label.innerText.trim()
    }
    const parentLabel = el.closest('label')
    if (parentLabel) return parentLabel.innerText && parentLabel.innerText.trim()
    const labelId = el.getAttribute('aria-labelledby')
    if (labelId) {
      const labelEl = document.getElementById(labelId)
      if (labelEl) return labelEl.innerText && labelEl.innerText.trim()
    }
    return ''
  }

  function getNearbyHeading(el) {
    let curr = el.parentElement
    for (let i = 0; i < 6; i++) {
      if (!curr) break
      const heading = curr.querySelector('h1,h2,h3,h4,h5,h6')
      if (heading && heading.innerText) return heading.innerText.trim().slice(0, 60)
      curr = curr.parentElement
    }
    return ''
  }

  function getFormContext(el) {
    const form = el.closest('form')
    if (!form) return ''
    return form.id || form.getAttribute('name') || form.getAttribute('aria-label') || ''
  }

  function getSectionContext(el) {
    const section = el.closest('section,article,main,aside,nav,[role="main"],[role="region"]')
    if (!section) return ''
    const heading = section.querySelector('h1,h2,h3,h4')
    return (heading && heading.innerText && heading.innerText.trim().slice(0, 60)) || section.getAttribute('aria-label') || ''
  }

  function getTagPath(el) {
    const path = []
    let curr = el
    for (let i = 0; i < 5; i++) {
      if (!curr || curr === document.body) break
      let part = curr.tagName.toLowerCase()
      if (curr.id) part += '#' + curr.id
      else if (curr.getAttribute('data-testid')) part += '[data-testid="' + curr.getAttribute('data-testid') + '"]'
      path.unshift(part)
      curr = curr.parentElement
    }
    return path.join(' > ')
  }

  function isInShadowDOM(el) {
    return el.getRootNode() instanceof ShadowRoot
  }

  function getFingerprint(el) {
    if (!el || el === document.body || el === document.documentElement) return null

    let target = el
    for (let i = 0; i < 6; i++) {
      if (!target || target === document.body) break
      const tag = target.tagName && target.tagName.toLowerCase()
      if (['a','button','input','select','textarea','label','summary'].includes(tag)) break
      if (target.getAttribute('role')) break
      if (target.getAttribute('data-testid')) break
      if (target.onclick || target.getAttribute('onclick')) break
      try { if (window.getComputedStyle(target).cursor === 'pointer') break } catch (e) {}
      target = target.parentElement
    }
    if (!target || target === document.body) target = el

    const text = (target.innerText || target.textContent || '').trim()
    const NOISE = ['cookie','privacy','terms of','subscribe','newsletter',
                   'powered by','copyright','all rights reserved']
    if (NOISE.some(function(n) { return text.toLowerCase().indexOf(n) !== -1 })) return null

    let rect = { x: 0, y: 0, width: 0, height: 0 }
    try { rect = target.getBoundingClientRect() } catch (e) {}
    let style = { visibility: '', display: '' }
    try { style = window.getComputedStyle(target) } catch (e) {}
    const isVisible = rect.width > 0 && rect.height > 0 &&
                      style.visibility !== 'hidden' &&
                      style.display !== 'none'

    return {
      tag: target.tagName && target.tagName.toLowerCase(),
      id: target.id || '',
      testid: target.getAttribute('data-testid') || '',
      ariaLabel: target.getAttribute('aria-label') || '',
      ariaRole: target.getAttribute('role') || '',
      text: text.slice(0, 150),
      placeholder: target.getAttribute('placeholder') || '',
      inputType: target.getAttribute('type') || '',
      name: target.getAttribute('name') || '',
      href: target.getAttribute('href') || '',
      value: target.value || '',
      isDisabled: target.disabled || target.getAttribute('aria-disabled') === 'true',
      isVisible: isVisible,
      inShadowDOM: isInShadowDOM(target),
      nearbyLabel: getNearbyLabel(target) || '',
      nearbyHeading: getNearbyHeading(target) || '',
      formContext: getFormContext(target) || '',
      sectionContext: getSectionContext(target) || '',
      tagPath: getTagPath(target),
      boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y),
                     w: Math.round(rect.width), h: Math.round(rect.height) }
    }
  }

  function emit(event) {
    window.postMessage({ type: '__FLOW_RECORDER_V2__', event: event }, '*')
  }

  // Click
  document.addEventListener('click', function(e) {
    const fp = getFingerprint(e.target)
    if (!fp) return
    emit({ action: 'click', element: fp, x: Math.round(e.clientX), y: Math.round(e.clientY),
           url: location.href, timestamp: Date.now() })
  }, true)

  // Double click
  document.addEventListener('dblclick', function(e) {
    const fp = getFingerprint(e.target)
    if (!fp) return
    emit({ action: 'dblclick', element: fp, x: Math.round(e.clientX), y: Math.round(e.clientY),
           url: location.href, timestamp: Date.now() })
  }, true)

  // Hover — only elements with tooltip attributes, after 700ms dwell
  let hoverTimer = null
  document.addEventListener('mouseover', function(e) {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(function() {
      const el = e.target
      const hasTooltip = el.title || el.getAttribute('aria-label') ||
                         el.getAttribute('data-tooltip') || el.getAttribute('data-title') ||
                         el.getAttribute('data-tip')
      if (!hasTooltip) return
      const fp = getFingerprint(el)
      if (!fp) return
      emit({ action: 'hover', element: fp,
             tooltip: el.title || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '',
             x: Math.round(e.clientX), y: Math.round(e.clientY),
             url: location.href, timestamp: Date.now() })
    }, 700)
  }, true)

  // HTML5 drag and drop
  let dragSource = null
  document.addEventListener('dragstart', function(e) {
    dragSource = { element: getFingerprint(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY) }
  }, true)

  document.addEventListener('drop', function(e) {
    if (!dragSource) return
    e.preventDefault()
    const fp = getFingerprint(e.target)
    emit({ action: 'drag', from: dragSource,
           to: { element: fp, x: Math.round(e.clientX), y: Math.round(e.clientY) },
           url: location.href, timestamp: Date.now() })
    dragSource = null
  }, true)

  // Mouse-based drag for non-HTML5-draggable elements
  let mouseDownInfo = null
  let mouseMoved = false
  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return
    mouseDownInfo = { element: getFingerprint(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), timestamp: Date.now() }
    mouseMoved = false
  }, true)

  document.addEventListener('mousemove', function(e) {
    if (!mouseDownInfo) return
    if (Math.abs(e.clientX - mouseDownInfo.x) > 10 || Math.abs(e.clientY - mouseDownInfo.y) > 10) mouseMoved = true
  }, true)

  document.addEventListener('mouseup', function(e) {
    if (!mouseDownInfo || !mouseMoved) { mouseDownInfo = null; mouseMoved = false; return }
    const fp = getFingerprint(e.target)
    if (fp && mouseDownInfo.element) {
      emit({ action: 'drag', from: mouseDownInfo,
             to: { element: fp, x: Math.round(e.clientX), y: Math.round(e.clientY) },
             url: location.href, timestamp: Date.now() })
    }
    mouseDownInfo = null
    mouseMoved = false
  }, true)

  // Type / Input — debounced 600ms, keeps only final value
  const typeDebounce = {}
  document.addEventListener('input', function(e) {
    const el = e.target
    const tag = el.tagName && el.tagName.toLowerCase()
    if (!['input','textarea'].includes(tag)) return
    const key = el.id || el.name || el.getAttribute('data-testid') || tag
    clearTimeout(typeDebounce[key])
    typeDebounce[key] = setTimeout(function() {
      const fp = getFingerprint(el)
      if (!fp) return
      emit({ action: 'type', element: fp,
             value: el.type === 'password' ? '***' : el.value,
             url: location.href, timestamp: Date.now() })
    }, 600)
  }, true)

  // Select / checkbox / radio / file
  document.addEventListener('change', function(e) {
    const el = e.target
    const tag = el.tagName && el.tagName.toLowerCase()
    if (tag === 'select') {
      const selected = el.options[el.selectedIndex]
      emit({ action: 'select', element: getFingerprint(el),
             value: (selected && selected.value) || '',
             label: (selected && selected.text && selected.text.trim()) || '',
             url: location.href, timestamp: Date.now() })
    }
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      emit({ action: el.checked ? 'check' : 'uncheck', element: getFingerprint(el),
             url: location.href, timestamp: Date.now() })
    }
    if (tag === 'input' && el.type === 'file') {
      emit({ action: 'file_upload', element: getFingerprint(el),
             fileCount: (el.files && el.files.length) || 0,
             fileTypes: Array.prototype.map.call(el.files || [], function(f) { return f.type }),
             url: location.href, timestamp: Date.now() })
    }
  }, true)

  // Keyboard shortcuts and named special keys only
  document.addEventListener('keydown', function(e) {
    const isShortcut = e.ctrlKey || e.metaKey
    const SPECIAL = ['Enter','Tab','Escape','F1','F2','F3','F4','F5',
                     'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
                     'PageUp','PageDown','Home','End']
    if (!isShortcut && SPECIAL.indexOf(e.key) === -1) return
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) return
    emit({ action: 'keypress', key: e.key,
           ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey,
           element: getFingerprint(document.activeElement),
           url: location.href, timestamp: Date.now() })
  }, true)

  // Scroll — debounced 400ms, significant movements only (>150px)
  let scrollDebounce = null
  let lastScrollY = window.scrollY
  let lastScrollX = window.scrollX
  document.addEventListener('scroll', function() {
    clearTimeout(scrollDebounce)
    scrollDebounce = setTimeout(function() {
      const dy = window.scrollY - lastScrollY
      const dx = window.scrollX - lastScrollX
      if (Math.abs(dy) < 150 && Math.abs(dx) < 150) return
      lastScrollY = window.scrollY
      lastScrollX = window.scrollX
      emit({ action: 'scroll',
             direction: Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left'),
             amount: Math.round(Math.abs(dy) || Math.abs(dx)),
             scrollY: Math.round(window.scrollY), scrollX: Math.round(window.scrollX),
             url: location.href, timestamp: Date.now() })
    }, 400)
  }, { passive: true, capture: true })

  // Form submit
  document.addEventListener('submit', function(e) {
    emit({ action: 'submit', element: getFingerprint(e.target),
           url: location.href, timestamp: Date.now() })
  }, true)

  // SPA navigation via pushState / replaceState / hashchange
  const _pushState = history.pushState
  history.pushState = function() {
    _pushState.apply(this, arguments)
    setTimeout(function() { emit({ action: 'navigate', url: location.href, spa: true, timestamp: Date.now() }) }, 50)
  }

  const _replaceState = history.replaceState
  history.replaceState = function() {
    _replaceState.apply(this, arguments)
    setTimeout(function() { emit({ action: 'navigate', url: location.href, spa: true, replace: true, timestamp: Date.now() }) }, 50)
  }

  window.addEventListener('hashchange', function() {
    emit({ action: 'navigate', url: location.href, spa: true, hash: true, timestamp: Date.now() })
  })

  // Right click / context menu
  document.addEventListener('contextmenu', function(e) {
    const fp = getFingerprint(e.target)
    if (!fp) return
    emit({ action: 'rightclick', element: fp, x: Math.round(e.clientX), y: Math.round(e.clientY),
           url: location.href, timestamp: Date.now() })
  }, true)

  // Focus on form fields — marks entry points for accessibility flows
  document.addEventListener('focusin', function(e) {
    const el = e.target
    const tag = el.tagName && el.tagName.toLowerCase()
    if (!['input','textarea','select'].includes(tag)) return
    const fp = getFingerprint(el)
    if (!fp) return
    emit({ action: 'focus', element: fp, url: location.href, timestamp: Date.now() })
  }, true)

})()
`

  try {
    await sendCDP(tabId, 'Runtime.evaluate', { expression: script, awaitPromise: false })
  } catch (err) {
    console.error('Injection failed for tab', tabId, err)
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    await initPromise

    switch (message.type) {
      case 'START_RECORDING': {
        // Reset segments state so each phase records clean
        segments = []
        currentSegmentIndex = 0
        chrome.storage.session.set({
          segments: [],
          currentSegmentIndex: 0
        })
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        const tab = tabs[0]
        if (!tab) { sendResponse({ success: false, error: 'No active tab' }); return }
        try {
          await startRecording(tab.id, tab.url)
          sendResponse({ success: true })
        } catch (e) {
          sendResponse({ success: false, error: e.message })
        }
        break
      }

      case 'STOP_RECORDING': {
        isRecording = false
        recordingTabs.forEach(tabId => detachDebugger(tabId))
        recordingTabs.clear()

        // Drain any unlinked network entries into networkLog for the global summary
        for (const [requestId, req] of networkBuffer.entries()) {
          const res = responseBuffer.get(requestId)
          if (res && isApiCall(req.url, res.mimeType || '')) {
            networkLog.push({
              url: cleanUrl(req.url),
              status: res.response_status,
              method: req.method,
              ms: res.timing_ms,
              failed: res.response_status >= 400 || res.response_status === 0
            })
          }
        }
        networkBuffer.clear()
        responseBuffer.clear()

        const grouped = groupIntoBusinessSteps([...recording])
        const result = {
          success: true,
          recording: grouped,
          networkLog: [...networkLog],
          consoleErrors: [...consoleLog],   // key kept as consoleErrors for popup.js compat
          startUrl,
          sessionState: { ...recordingMetadata }
        }

        if (segments.length > 0 && recording.length > 0) {
          segments[currentSegmentIndex] = [...recording]
          chrome.storage.session.set({ segments, currentSegmentIndex })
        }

        recording = []
        networkLog = []
        consoleLog = []
        startUrl = ''
        lastNavigateUrl = ''
        recordingMetadata = {}
        await saveState()

        sendResponse(result)
        break
      }

      case 'RECORD_EVENT': {
        if (!isRecording) { sendResponse({ success: true }); return }
        const tabId = sender.tab && sender.tab.id
        if (!tabId || !recordingTabs.has(tabId)) { sendResponse({ success: true }); return }
        await processEvent(message.event, tabId)
        sendResponse({ success: true })
        break
      }

      case 'GET_RECORDING':
        sendResponse({ isRecording, recording, networkLog, startUrl })
        break

      case 'FORCE_CHECKPOINT':
        segments[currentSegmentIndex] = [...recording]
        recording = []
        currentSegmentIndex++
        chrome.storage.session.set({ segments, currentSegmentIndex })
        sendResponse({ type: 'CHECKPOINT_DONE', segmentIndex: currentSegmentIndex })
        return true

      case 'RESUME_RECORDING':
        recording = []
        isRecording = true
        // re-attach CDP to active tab
        chrome.tabs.query({ active: true, currentWindow: true },
          async (tabs) => {
            if (!tabs[0]) return
            const tabId = tabs[0].id
            const targets = await chrome.debugger.getTargets()
            const alreadyAttached = targets.some(t =>
              t.tabId === tabId && t.attached)
            if (!alreadyAttached) attachDebugger(tabId)
          })
        sendResponse({ success: true })
        return true

      case 'CLEAR_RECORDING':
        isRecording = false
        recordingTabs.forEach(tabId => detachDebugger(tabId))
        recordingTabs.clear()
        recording = []
        networkLog = []
        consoleLog = []
        networkBuffer.clear()
        responseBuffer.clear()
        startUrl = ''
        lastNavigateUrl = ''
        recordingMetadata = {}
        await saveState()
        sendResponse({ success: true })
        break

      default:
        sendResponse({ error: 'Unknown message type' })
    }
  })()
  return true
})