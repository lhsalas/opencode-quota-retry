import { Plugin } from "@opencode/plugin/gui"
import { QuotaRetryRpc, type RetryNotice } from "./rpc"

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

function variantFor(kind: RetryNotice["kind"]): "default" | "success" | "error" {
  if (kind === "recovered") return "success"
  if (kind === "exhausted" || kind === "error") return "error"
  return "default"
}

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(QuotaRetryRpc)
    const clientID = `desktop-${crypto.randomUUID()}`

    const unsubscribe = rpc.events.on("status", (event) => {
      if (!isRetryNotice(event.data)) return

      const notice = event.data
      const currentDirectory = ctx.sessions.current()?.directory
      if (currentDirectory && event.location.directory !== currentDirectory) return

      ctx.toast.show({
        title: titleFor(notice.providerID),
        description: notice.message,
        variant: variantFor(notice.kind),
        duration: notice.kind === "recovered" || notice.kind === "exhausted" ? 10_000 : 7_000,
      })

      void ctx.attention.notify({
        title: titleFor(notice.providerID),
        message: notice.message,
        variant: notice.kind === "exhausted" || notice.kind === "error" ? "error" : "default",
        sound:
          notice.kind === "recovered" || notice.kind === "exhausted" || notice.kind === "error",
        id: notice.id,
      })
    })

    const sendHeartbeat = (active: boolean) =>
      rpc.heartbeat({ clientID, active, surface: "desktop" }).catch(() => undefined)

    void sendHeartbeat(true)
    const heartbeat = setInterval(() => void sendHeartbeat(true), HEARTBEAT_INTERVAL_MS)

    return async () => {
      clearInterval(heartbeat)
      unsubscribe()
      await sendHeartbeat(false)
    }
  },
})
