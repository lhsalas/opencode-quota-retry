# OpenCode Quota Retry

An OpenCode plugin that waits for OpenAI usage-limit errors to clear, then continues affected sessions. It supports the
OpenCode TUI and Desktop app.

## What it does

- Detects OpenAI provider rate-limit/quota errors from the OpenCode retry hook.
- Queues affected sessions and makes one continuation probe every 30 minutes by default.
- Tries at most 10 delayed retries in one quota-limit cycle. The original failed request is not included in that count.
- Sends a continuation in the same session rather than replaying the original prompt.
- Notifies on each failed probe, on recovery, and when the retry limit is exhausted.
- Keeps pending session IDs locally so the next time the TUI or Desktop app becomes active it can probe immediately.
- Cancels the in-memory wait when the last UI client disconnects. It does not persist a wait deadline or retry count.

OpenCode does not expose the reset time for an OpenAI subscription through its usage-limits endpoint. A successful
continuation request is therefore the signal that the provider is accepting requests again.

## Install with OpenCode Agent

Paste this prompt into an OpenCode Agent to install the plugin for both TUI and Desktop. It asks the Agent to use a
global OpenCode config so the plugin is available across projects.

```text
Install OpenCode Quota Retry from:
https://github.com/lhsalas/opencode-quota-retry

Goal: enable it for both OpenCode TUI and Desktop on this machine.

Safety:
- Do not read, print, copy, or upload API keys, credentials, session transcripts,
  provider response bodies, or other secrets.
- Do not make real OpenAI requests, edit the current project, or commit or push
  changes.
- Do not modify source files in the cloned plugin repository; only install its
  dependencies and build the generated Desktop bundle.
- Preserve all existing OpenCode settings. If the config cannot be safely updated,
  stop and ask me before changing it.
- Do not upgrade or install Node.js or OpenCode globally without asking.

Steps:
1. Check that OpenCode is 2.3 or later and Node.js is 22.12 or later.
2. Clone the public repo into a stable user-local directory. If it already exists,
   update it only with a fast-forward pull when its Git working tree is clean.
   If it has local changes, leave it untouched and ask me what to do.
3. In the clone, run `npm ci`, `npm test`, and `npm run build`. These checks must
   not make provider requests.
4. Add this plugin entry to the `plugins` array in the global `opencode.json`
   or `opencode.jsonc`, preserving every other setting. If no global config
   exists, create it using this structure:

   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "<absolute path to the clone>",
         "options": {
           "providerID": "openai",
           "intervalMinutes": 30,
           "maxRetries": 10
         }
       }
     ]
   }

5. Use one global plugin entry for both surfaces. Do not add a duplicate TUI
   entry to `cli.json`; OpenCode loads the TUI part from the configured package.
6. Reload or reopen OpenCode if needed. Verify the plugin loads and tell me
   whether Desktop system notifications need to be enabled in Settings.

Report only the install path, the config key added, and test results. Do not
include secrets or the full config contents in your report.
```

The prompt uses the public repository and does not need GitHub authentication or an OpenAI API key. OpenCode uses the
provider credentials already configured on the user's machine.

## Install from source

Requirements:

- OpenCode 2.3 or later.
- Node.js 22.12 or later and npm.

Clone the repository, install dependencies, and build the Desktop bundle:

```sh
git clone https://github.com/lhsalas/opencode-quota-retry.git
cd opencode-quota-retry
npm install
npm run build
```

Add the local package to your existing `opencode.json` or `opencode.jsonc` without replacing other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-quota-retry",
      "options": {
        "providerID": "openai",
        "intervalMinutes": 30,
        "maxRetries": 10
      }
    }
  ]
}
```

OpenCode loads the server plugin and Desktop GUI plugin from this entry. The CLI automatically loads the TUI part from a
configured server plugin package.

After changing the plugin's source, run `npm run build` again so Desktop uses the latest GUI bundle.

## Notifications

The plugin shows an in-app toast and requests a system notification when the UI is blurred.

Examples:

- “The OpenAI limit is active. Retry 1/10 is scheduled in 30 minutes.”
- “The OpenAI limit is still active on retry 4/10. Retry 5/10 is scheduled in 30 minutes.”
- “The OpenAI limit accepted a request on retry 5/10. Work is continuing.”
- “The OpenAI limit is still active after 10/10 retries. Close and reopen OpenCode to try again.”

Desktop system notifications follow OpenCode's **Settings → Notifications** preferences. Retry status and session IDs
stay in OpenCode's local runtime; provider response bodies and credentials are not stored or published.

## Process and retry behavior

- Retry count is per active run. Closing all UI clients cancels the timer and resets the count.
- Pending session IDs remain in OpenCode's local plugin storage. On the next TUI/Desktop activation, the plugin attempts
  an immediate continuation; if still limited, it starts a new 30-minute wait.
- The TUI and Desktop plugin send a heartbeat every 15 seconds. A graceful close unregisters immediately; a lost client
  is treated as inactive after 45 seconds.
- With multiple sessions, one provider probe runs at a time. Other affected sessions wait in a local queue.
- A successful probe resumes queued sessions one at a time. A later quota failure starts a new cooldown cycle.
- The plugin only automatically retries matching provider limit errors. Other provider errors stop the retry for that
  session and show an error notification.

The GUI extension point is currently experimental in OpenCode. See the [GUI plugin guide](https://opencode.ai/docs/build/plugins/gui),
[TUI plugin guide](https://opencode.ai/docs/build/plugins/cli), and [server plugin guide](https://opencode.ai/docs/build/plugins/server).
The server also uses OpenCode's experimental session-wait API to avoid queuing a continuation behind work already running
in that session.

## Development

```sh
npm test
npm run typecheck
npm run build
```

Tests use simulated failures and fake timers; they do not make OpenAI requests or require credentials.

## Privacy

This repository contains no account credentials, API keys, session transcripts, provider error bodies, or personal
configuration. The runtime stores pending session IDs only in OpenCode's local plugin storage.
