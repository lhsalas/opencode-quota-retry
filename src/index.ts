import { Plugin } from "@opencode/plugin"
import { QuotaRetryRpc, type HeartbeatInput, type RetryNotice } from "./rpc.js"
import { CONTINUATION_TEXT, RetryManager } from "./retry-manager.js"

const STORAGE_KEY = "pending-sessions-v1"
const HEARTBEAT_TIMEOUT_MS = 45_000
const HEARTBEAT_SWEEP_MS = 5_000

interface StoredPending {
  sessionIDs?: unknown
}

interface RetryOptions {
  providerID: string
  intervalMs: number
  maxRetries: number
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function getOptions(options: Readonly<Record<string, unknown>>): RetryOptions {
  const providerID =
    typeof options.providerID === "string" && options.providerID.trim()
      ? options.providerID.trim()
      : "openai"
  const intervalMinutes = boundedNumber(options.intervalMinutes, 30, 1, 240)
  const maxRetries = boundedNumber(options.maxRetries, 10, 1, 10)

  return {
    providerID,
    intervalMs: intervalMinutes * 60_000,
    maxRetries,
  }
}

function isQuotaLimitError(error: { status?: number; type: string; message: string }): boolean {
  return (
    error.status === 429 ||
    /rate.?limit|quota|usage.?limit|exhausted/i.test(`${error.type} ${error.message}`)
  )
}

export default Plugin.define({
  id: "opencode-quota-retry",
  async setup(ctx) {
    const options = getOptions(ctx.options)
    let publishStatus: (notice: RetryNotice) => Promise<void> = async () => undefined

    const manager = new RetryManager(
      {
        ...options,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      },
      {
        async loadPending() {
          const stored = (await ctx.storage.get(STORAGE_KEY)) as StoredPending | undefined
          if (!stored || !Array.isArray(stored.sessionIDs)) return []
          return stored.sessionIDs.filter((value): value is string => typeof value === "string")
        },
        async savePending(sessionIDs) {
          await ctx.storage.set(STORAGE_KEY, { sessionIDs })
        },
      },
      {
        async waitForIdle(sessionID, signal) {
          await ctx.session.wait({ sessionID }, { signal })
        },
        async continueSession(sessionID, attempt, messageID, signal) {
          if (signal.aborted) return
          await ctx.session.prompt({
            sessionID,
            id: messageID,
            text: CONTINUATION_TEXT,
            metadata: {
              quotaRetry: {
                id: messageID,
                attempt,
              },
            },
            delivery: "queue",
          }, { signal })
        },
        async interruptSession(sessionID) {
          await ctx.session.interrupt({ sessionID })
        },
        async publish(notice) {
          await publishStatus(notice)
        },
      },
    )

    await manager.restore()

    const rpcRegistration = await ctx.rpc.register(QuotaRetryRpc, {
      async heartbeat(input) {
        return manager.heartbeat(input as HeartbeatInput)
      },
      async status() {
        return manager.snapshot()
      },
    })
    publishStatus = (notice) => rpcRegistration.events.emit("status", notice)

    const retryRegistration = await ctx.session.hook(
      "retry",
      async (event) => {
        if (event.model.providerID !== options.providerID || !isQuotaLimitError(event.error)) return

        // The outer process-local manager owns the wait/retry budget. Avoid
        // OpenCode's short internal retry here so a closed UI cannot leave a
        // long retry sleeping in the background server.
        const handled = await manager.quotaFailure(event.sessionID)
        if (handled) event.decision = { retry: false }
      },
      { providerID: options.providerID },
    )

    const promptRegistration = await ctx.session.hook("prompt", async (event) => {
      const retryMetadata = event.metadata?.quotaRetry
      if (
        retryMetadata &&
        typeof retryMetadata === "object" &&
        "id" in retryMetadata &&
        typeof retryMetadata.id === "string"
      ) {
        return
      }
      await manager.userPrompt(event.sessionID)
    })

    const responseRegistration = await ctx.session.hook(
      "http.response",
      async (event) => {
        if (
          event.model.providerID !== options.providerID ||
          event.kind !== "primary" ||
          event.response.status < 200 ||
          event.response.status >= 400
        ) {
          return
        }
        await manager.providerRequestAccepted(event.sessionID)
      },
      { providerID: options.providerID },
    )

    const eventController = new AbortController()
    const eventTask = (async () => {
      for await (const event of ctx.event.subscribe({
        signal: eventController.signal,
        types: [
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.deleted",
        ],
      })) {
        if (event.type === "session.execution.succeeded") {
          await manager.executionSucceeded(event.data.sessionID)
        } else if (event.type === "session.execution.failed") {
          await manager.executionFailed(
            event.data.sessionID,
            isQuotaLimitError(event.data.error),
          )
        } else if (event.type === "session.execution.interrupted") {
          await manager.executionInterrupted(event.data.sessionID)
        } else if (event.type === "session.deleted") {
          await manager.sessionDeleted(event.data.sessionID)
        }
      }
    })().catch(() => {
      if (!eventController.signal.aborted) {
        console.error("[opencode-quota-retry] Event listener stopped.")
      }
    })

    const sweep = setInterval(() => {
      void manager.expireInactiveClients().catch(() => {
        console.error("[opencode-quota-retry] Heartbeat sweep failed.")
      })
    }, HEARTBEAT_SWEEP_MS)

    return async () => {
      clearInterval(sweep)
      eventController.abort()
      await responseRegistration.dispose()
      await promptRegistration.dispose()
      await retryRegistration.dispose()
      await rpcRegistration.dispose()
      await manager.stop()
      await eventTask
    }
  },
})
