// Relay events from the CDP-injected page script to the background service worker
window.addEventListener('message', function(e) {
  if (e.source !== window) return
  if (!e.data || e.data.type !== '__FLOW_RECORDER_V2__') return
  chrome.runtime.sendMessage({ type: 'RECORD_EVENT', event: e.data.event }).catch(function() {})
})
