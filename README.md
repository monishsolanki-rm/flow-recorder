# Flow Recorder

A Chrome extension that records user interactions on any website and generates a clean YAML test flow using AI.

## Setup

1. Download the repository to your local machine (either clone it via Git or download and extract the ZIP file).

2. Open Chrome and go to chrome://extensions

3. Enable Developer mode (toggle in top-right corner)

4. Click Load unpacked and select the flow-recorder/ folder from your downloaded files

5. The extension icon appears in your toolbar — click it to open the popup

## Usage

1. Click **Start Recording** in the popup
2. Browse your app normally — clicks, typing, navigation are all captured
3. Click **Stop Recording** when done
4. Review the captured steps, then fill in:
   - **Flow name** — e.g. "User Login Flow"
   - **Expected outcome** — what should happen at the end
   - **Groq API key** — saved locally for future use
5. Click **Generate YAML** — your test flow downloads automatically


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
