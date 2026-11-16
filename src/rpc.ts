import { Rpc } from "@opencode/plugin/rpc"

const heartbeatInput = {
  type: "object",
  properties: {
    clientID: { type: "string" },
    active: { type: "boolean" },
    surface: { type: "string", enum: ["tui", "desktop"] },
  },
  required: ["clientID", "active", "surface"],
  additionalProperties: false,
} as const

const snapshotOutput = {
  type: "object",
  properties: {
    activeClients: { type: "integer" },
    pendingSessions: { type: "integer" },
    attempts: { type: "integer" },
    maxRetries: { type: "integer" },
    nextAttemptAt: { anyOf: [{ type: "integer" }, { type: "null" }] },
  },
  required: ["activeClients", "pendingSessions", "attempts", "maxRetries", "nextAttemptAt"],
  additionalProperties: false,
} as const

const statusEvent = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: {
      type: "string",
      enum: ["waiting", "still_limited", "recovered", "exhausted", "paused", "error"],
    },
    providerID: { type: "string" },
    sessionID: { type: "string" },
    attempt: { type: "integer" },
    nextAttempt: { type: "integer" },
    maxRetries: { type: "integer" },
    nextAttemptAt: { anyOf: [{ type: "integer" }, { type: "null" }] },
    pendingSessions: { type: "integer" },
    message: { type: "string" },
  },
  required: ["id", "kind", "providerID", "attempt", "maxRetries", "pendingSessions", "message"],
  additionalProperties: false,
} as const

export const QuotaRetryRpc = Rpc.define({
  id: "opencode-quota-retry",
  methods: {
    heartbeat: {
      input: heartbeatInput,
      output: snapshotOutput,
    },
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: snapshotOutput,
    },
  },
  events: {
    status: {
      schema: statusEvent,
    },
  },
})

export type RetryNoticeKind =
  | "waiting"
  | "still_limited"
  | "recovered"
  | "exhausted"
  | "paused"
  | "error"

export interface RetryNotice {
  [key: string]: unknown
  id: string
  kind: RetryNoticeKind
  providerID: string
  sessionID?: string
  /** Delayed retry number. Zero means an immediate startup probe. */
  attempt: number
  nextAttempt?: number
  maxRetries: number
  nextAttemptAt?: number | null
  pendingSessions: number
  message: string
}

export interface RetrySnapshot {
  activeClients: number
  pendingSessions: number
  attempts: number
  maxRetries: number
  nextAttemptAt: number | null
}

export interface HeartbeatInput {
  clientID: string
  active: boolean
  surface: "tui" | "desktop"
}
