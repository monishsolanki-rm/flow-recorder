# Flow Recorder

A Chrome extension that records user interactions on any website and generates a clean YAML test flow using AI.

## Setup

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked** and select the `flow-recorder/` folder
4. The extension icon appears in your toolbar — click it to open the popup

## Usage

1. Click **Start Recording** in the popup
2. Browse your app normally — clicks, typing, navigation are all captured
3. Click **Stop Recording** when done
4. Review the captured steps, then fill in:
   - **Flow name** — e.g. "User Login Flow"
   - **Expected outcome** — what should happen at the end
   - **Groq API key** — saved locally for future use
5. Click **Generate YAML** — your test flow downloads automatically

## Getting a Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up for free — no credit card required
3. Create an API key under **API Keys**
4. Paste it into the extension (it's saved in your browser, never sent anywhere except Groq)

## Switching to Claude

To use Claude instead of Groq, change only these three things in `popup/popup.js` inside the `callGroq` function:

- **URL**: `https://api.anthropic.com/v1/messages`
- **Headers**: replace `Authorization: Bearer` with `x-api-key` and add `anthropic-version: 2023-06-01`
- **Body**: use `{ model: "claude-opus-4-7", max_tokens: 2048, messages: [...] }` and read from `response.content[0].text`

Everything else — the prompt, the UI, the recording logic — stays identical.

## What gets recorded

| Action | Captured when |
|--------|---------------|
| `click` | User clicks any element |
| `type` | User types into an input (passwords masked as `***`) |
| `submit` | Form is submitted |
| `navigate` | Page URL changes |

Noise elements (cookie banners, newsletter popups, privacy notices) are automatically filtered out.

## Selector priority

The extension picks identifiers in this order: `data-testid` → `id` → `aria-label` → visible text → placeholder
