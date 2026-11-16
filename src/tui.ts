import { Plugin } from "@opencode/plugin/tui"
import { randomUUID } from "node:crypto"
import { QuotaRetryRpc, type RetryNotice } from "./rpc.js"

const HEARTBEAT_INTERVAL_MS = 15_000
const titleFor = (providerID: string) =>
  `${providerID.toLowerCase() === "openai" ? "OpenAI" : providerID} usage limit`

function isRetryNotice(value: unknown): value is RetryNotice {
  if (!value || typeof value !== "object") return false
  const notice = value as Partial<RetryNotice>
  return (
    typeof notice.id === "string" &&
    typeof notice.kind === "string" &&
    typeof notice.message === "string" &&
    typeof notice.attempt === "number" &&
    typeof notice.maxRetries === "number"
  )
}

function variantFor(kind: RetryNotice["kind"]): "info" | "success" | "warning" | "error" {
  if (kind === "recovered") return "success"
  if (kind === "exhausted" || kind === "error") return "error"
  if (kind === "waiting" || kind === "still_limited") return "warning"
  return "info"
}

export default Plugin.define({
  id: "opencode-quota-retry.tui",
  setup(context) {
    const rpc = context.client.rpc(QuotaRetryRpc)
    const clientID = `tui-${randomUUID()}`
    const seenNoticeIDs = new Set<string>()

    const unsubscribe = rpc.events.on("status", (event) => {
      if (!isRetryNotice(event.data)) return

      const notice = event.data
      if (seenNoticeIDs.has(notice.id)) return
      seenNoticeIDs.add(notice.id)
      if (seenNoticeIDs.size > 500) {
        const oldest = seenNoticeIDs.values().next().value
        if (oldest) seenNoticeIDs.delete(oldest)
      }

      const currentDirectory =
        context.location?.directory ?? context.data.location.default()?.directory
      if (currentDirectory && event.location.directory !== currentDirectory) return

      context.ui.toast.show({
        title: titleFor(notice.providerID),
        message: notice.message,
        variant: variantFor(notice.kind),
        duration: notice.kind === "recovered" || notice.kind === "exhausted" ? 10_000 : 7_000,
        sessionID: notice.sessionID,
      })

      void context.attention.notify({
        title: titleFor(notice.providerID),
        message: notice.message,
        notification: { when: "blurred" },
        sound:
          notice.kind === "recovered"
            ? { name: "done", when: "always" }
            : notice.kind === "exhausted" || notice.kind === "error"
              ? { name: "error", when: "always" }
              : false,
      })
    })

    const sendHeartbeat = (active: boolean) =>
      rpc.heartbeat({ clientID, active, surface: "tui" }).catch(() => undefined)

    void sendHeartbeat(true)
    const heartbeat = setInterval(() => void sendHeartbeat(true), HEARTBEAT_INTERVAL_MS)

    return async () => {
      clearInterval(heartbeat)
      unsubscribe()
      await sendHeartbeat(false)
    }
  },
})
