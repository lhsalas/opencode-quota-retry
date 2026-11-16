import { randomUUID } from "node:crypto"
import type { HeartbeatInput, RetryNotice, RetrySnapshot } from "./rpc.js"

export interface RetryManagerOptions {
  providerID: string
  intervalMs: number
  maxRetries: number
  heartbeatTimeoutMs: number
}

export interface RetryManagerStorage {
  loadPending(): Promise<string[]>
  savePending(sessionIDs: string[]): Promise<void>
}

export interface RetryManagerDriver {
  waitForIdle(sessionID: string, signal: AbortSignal): Promise<void>
  continueSession(
    sessionID: string,
    attempt: number,
    messageID: string,
    signal: AbortSignal,
  ): Promise<void>
  interruptSession(sessionID: string): Promise<void>
  publish(notice: RetryNotice): Promise<void>
}

interface ActiveClient {
  lastSeen: number
  surface: HeartbeatInput["surface"]
}

interface InFlightAttempt {
  sessionID: string
  attempt: number
  controller: AbortController
}

interface PreparingAttempt extends InFlightAttempt {}

export const CONTINUATION_TEXT = [
  "Continue the interrupted task from the current session context.",
  "First inspect the current workspace and recent tool results to determine what already completed.",
  "Do not repeat completed or externally visible actions. Continue only the remaining work.",
].join(" ")

export interface RetryManagerClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const systemClock: RetryManagerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
}

export class RetryManager {
  private readonly pending = new Set<string>()
  private readonly clients = new Map<string, ActiveClient>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextAttemptAt: number | null = null
  private inFlight: InFlightAttempt | undefined
  private preparing: PreparingAttempt | undefined
  private attempts = 0
  private recoveredThisCycle = false
  private readonly manualOverrides = new Set<string>()
  private stopped = false

  constructor(
    private readonly options: RetryManagerOptions,
    private readonly storage: RetryManagerStorage,
    private readonly driver: RetryManagerDriver,
    private readonly clock: RetryManagerClock = systemClock,
  ) {}

  async restore(): Promise<void> {
    const sessionIDs = await this.storage.loadPending()
    this.pending.clear()
    for (const sessionID of sessionIDs) {
      if (sessionID) this.pending.add(sessionID)
    }

    // Keep the task marker, but intentionally do not restore a deadline or retry count.
    this.attempts = 0
    this.recoveredThisCycle = false
  }

  async heartbeat(input: HeartbeatInput): Promise<RetrySnapshot> {
    const wasActive = this.hasActiveClients()
    if (input.active) {
      this.clients.set(input.clientID, {
        lastSeen: this.clock.now(),
        surface: input.surface,
      })
    } else {
      this.clients.delete(input.clientID)
    }

    const isActive = this.hasActiveClients()
    if (wasActive && !isActive) {
      await this.pauseForNoClients()
    } else if (!wasActive && isActive && this.pending.size > 0) {
      this.attempts = 0
      this.recoveredThisCycle = false
      void this.startAttempt(0).catch(() => undefined)
    }

    return this.snapshot()
  }

  async expireInactiveClients(): Promise<void> {
    const cutoff = this.clock.now() - this.options.heartbeatTimeoutMs
    const wasActive = this.hasActiveClients()

    for (const [clientID, client] of this.clients) {
      if (client.lastSeen < cutoff) this.clients.delete(clientID)
    }

    if (wasActive && !this.hasActiveClients()) {
      await this.pauseForNoClients()
    }
  }

  async quotaFailure(sessionID: string): Promise<boolean> {
    if (this.stopped || this.manualOverrides.has(sessionID)) return false

    this.pending.add(sessionID)
    await this.persistPending()

    if (this.preparing?.sessionID === sessionID) return true

    if (this.inFlight?.sessionID === sessionID) {
      const failedAttempt = this.inFlight.attempt
      this.inFlight.controller.abort()
      this.inFlight = undefined

      if (!this.hasActiveClients()) {
        this.attempts = 0
        return true
      }

      if (failedAttempt === 0) {
        this.attempts = 0
        this.recoveredThisCycle = false
        this.schedule(1)
        return true
      }

      this.attempts = failedAttempt
      if (failedAttempt >= this.options.maxRetries) {
        await this.publish({
          kind: "exhausted",
          sessionID,
          attempt: failedAttempt,
          message: `The ${this.providerLabel()} limit is still active after ${failedAttempt}/${this.options.maxRetries} retries. Close and reopen OpenCode to try again.`,
        })
        return true
      }

      const nextAttempt = failedAttempt + 1
      await this.publish({
        kind: "still_limited",
        sessionID,
        attempt: failedAttempt,
        nextAttempt,
        nextAttemptAt: this.clock.now() + this.options.intervalMs,
        message: `The ${this.providerLabel()} limit is still active on retry ${failedAttempt}/${this.options.maxRetries}. Retry ${nextAttempt}/${this.options.maxRetries} is scheduled in ${this.intervalLabel()}.`,
      })
      this.schedule(nextAttempt)
      return true
    }

    // Several sessions can fail against the same account window. Keep them queued
    // behind one provider-level timer instead of probing the account in parallel.
    if (!this.inFlight && !this.timer && this.hasActiveClients()) {
      this.attempts = 0
      this.recoveredThisCycle = false
      this.schedule(1)
    } else if (!this.hasActiveClients()) {
      await this.publish({
        kind: "paused",
        sessionID,
        attempt: this.attempts,
        message: `The ${this.providerLabel()} limit was reached. Work is saved and will be checked when OpenCode becomes active again.`,
      })
    }
    return true
  }

  async userPrompt(sessionID: string): Promise<void> {
    if (
      !this.pending.has(sessionID) &&
      this.inFlight?.sessionID !== sessionID &&
      this.preparing?.sessionID !== sessionID
    ) {
      return
    }

    this.manualOverrides.add(sessionID)
    this.pending.delete(sessionID)
    if (this.preparing?.sessionID === sessionID) {
      this.preparing.controller.abort()
      this.preparing = undefined
    }
    if (this.inFlight?.sessionID === sessionID) {
      this.inFlight.controller.abort()
      this.inFlight = undefined
    }

    if (this.pending.size === 0) {
      this.clearTimer()
      this.nextAttemptAt = null
      this.attempts = 0
      this.recoveredThisCycle = false
    } else if (!this.inFlight && !this.timer) {
      this.scheduleImmediateResume()
    }
    await this.persistPending()
  }

  async executionSucceeded(sessionID: string): Promise<void> {
    if (this.manualOverrides.delete(sessionID)) return
    if (this.inFlight?.sessionID !== sessionID) return

    const successfulAttempt = this.inFlight.attempt
    this.inFlight.controller.abort()
    this.inFlight = undefined
    this.pending.delete(sessionID)
    await this.persistPending()

    if (!this.recoveredThisCycle) {
      await this.publish({
        kind: "recovered",
        sessionID,
        attempt: successfulAttempt,
        message:
          successfulAttempt === 0
            ? `The ${this.providerLabel()} limit appears reset: a request was accepted on the immediate startup check (0 delayed retries). Work is continuing.`
            : `The ${this.providerLabel()} limit appears reset: a request was accepted on retry ${successfulAttempt}/${this.options.maxRetries}. Work is continuing.`,
      })
      this.recoveredThisCycle = true
    }

    if (this.pending.size === 0) {
      this.attempts = 0
      this.recoveredThisCycle = false
      return
    }

    // The first successful probe confirms access has returned. Resume other
    // queued sessions one at a time; a fresh 429 starts a new cooldown cycle.
    this.attempts = 0
    this.scheduleImmediateResume()
  }

  async providerRequestAccepted(sessionID: string): Promise<void> {
    if (this.inFlight?.sessionID !== sessionID || this.recoveredThisCycle) return

    const successfulAttempt = this.inFlight.attempt
    await this.publish({
      kind: "recovered",
      sessionID,
      attempt: successfulAttempt,
      message:
        successfulAttempt === 0
          ? `The ${this.providerLabel()} limit appears reset: a request was accepted on the immediate startup check (0 delayed retries). Work is continuing.`
          : `The ${this.providerLabel()} limit appears reset: a request was accepted on retry ${successfulAttempt}/${this.options.maxRetries}. Work is continuing.`,
    })

    this.recoveredThisCycle = true
    this.inFlight.attempt = 0
    this.attempts = 0
  }

  async executionFailed(sessionID: string, quotaError: boolean): Promise<void> {
    if (this.manualOverrides.delete(sessionID)) return
    if (quotaError || this.inFlight?.sessionID !== sessionID) return

    this.inFlight.controller.abort()
    this.inFlight = undefined
    this.pending.delete(sessionID)
    await this.persistPending()
    await this.publish({
      kind: "error",
      sessionID,
      attempt: this.attempts,
      message: "The retry stopped because the provider returned a non-quota error. Automatic retries were not continued.",
    })
    if (this.pending.size === 0) {
      this.attempts = 0
      this.recoveredThisCycle = false
    } else {
      this.scheduleImmediateResume()
    }
  }

  async executionInterrupted(sessionID: string): Promise<void> {
    if (this.manualOverrides.delete(sessionID)) return
    if (this.preparing?.sessionID === sessionID) {
      this.preparing.controller.abort()
      this.preparing = undefined
      this.pending.delete(sessionID)
      await this.persistPending()
      if (this.pending.size > 0) this.scheduleImmediateResume()
      return
    }
    if (this.inFlight?.sessionID !== sessionID) return

    this.inFlight.controller.abort()
    this.inFlight = undefined
    this.pending.delete(sessionID)
    await this.persistPending()
    if (this.pending.size > 0) this.scheduleImmediateResume()
  }

  async sessionDeleted(sessionID: string): Promise<void> {
    this.manualOverrides.delete(sessionID)
    if (this.preparing?.sessionID === sessionID) {
      this.preparing.controller.abort()
      this.preparing = undefined
    }
    if (this.inFlight?.sessionID === sessionID) {
      this.inFlight.controller.abort()
      this.inFlight = undefined
    }
    this.pending.delete(sessionID)
    await this.persistPending()
    if (this.pending.size > 0 && !this.inFlight) this.scheduleImmediateResume()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    this.preparing?.controller.abort()
    this.preparing = undefined
    if (this.inFlight) {
      const sessionID = this.inFlight.sessionID
      this.inFlight.controller.abort()
      this.inFlight = undefined
      await this.driver.interruptSession(sessionID).catch(() => undefined)
    }
    this.clients.clear()
  }

  snapshot(): RetrySnapshot {
    return {
      activeClients: this.clients.size,
      pendingSessions: this.pending.size,
      attempts: this.attempts,
      maxRetries: this.options.maxRetries,
      nextAttemptAt: this.nextAttemptAt,
    }
  }

  private schedule(attempt: number): void {
    if (!this.hasActiveClients() || this.stopped || this.timer || this.inFlight || this.preparing) return

    this.clearTimer()
    this.nextAttemptAt = this.clock.now() + this.options.intervalMs
    if (attempt === 1) {
      void this.publish({
        kind: "waiting",
        attempt,
        nextAttemptAt: this.nextAttemptAt,
        message: `The ${this.providerLabel()} limit is active. Retry 1/${this.options.maxRetries} is scheduled in ${this.intervalLabel()}.`,
      }).catch(() => undefined)
    }

    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.nextAttemptAt = null
      void this.startAttempt(attempt).catch(() => undefined)
    }, this.options.intervalMs)
  }

  private scheduleImmediateResume(): void {
    if (!this.hasActiveClients() || this.stopped || this.timer || this.inFlight || this.preparing) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.startAttempt(0).catch(() => undefined)
    }, 0)
  }

  private async startAttempt(attempt: number): Promise<void> {
    if (!this.hasActiveClients() || this.stopped || this.inFlight || this.preparing || this.pending.size === 0) return

    const sessionID = this.pending.values().next().value
    if (!sessionID) return

    this.attempts = attempt
    const controller = new AbortController()
    const preparing = { sessionID, attempt, controller }
    this.preparing = preparing
    try {
      await this.driver.waitForIdle(sessionID, controller.signal)
      if (
        controller.signal.aborted ||
        this.preparing !== preparing ||
        !this.hasActiveClients() ||
        !this.pending.has(sessionID)
      ) {
        return
      }

      this.preparing = undefined
      this.inFlight = preparing
      await this.persistPending()
      if (controller.signal.aborted || this.inFlight !== preparing) return

      const messageID = `msg_${randomUUID().replaceAll("-", "")}`
      await this.driver.continueSession(sessionID, attempt, messageID, controller.signal)
    } catch {
      if (this.preparing === preparing) this.preparing = undefined
      if (this.inFlight === preparing) {
        this.inFlight.controller.abort()
        this.inFlight = undefined
      }
      if (controller.signal.aborted) return
      await this.publish({
        kind: "error",
        sessionID,
        attempt,
        message: "OpenCode could not submit the continuation. The task remains pending for the next active session.",
      }).catch(() => undefined)
    }
  }

  private async pauseForNoClients(): Promise<void> {
    this.clearTimer()
    this.nextAttemptAt = null
    this.attempts = 0
    this.recoveredThisCycle = false

    this.preparing?.controller.abort()
    this.preparing = undefined
    if (this.inFlight) {
      const sessionID = this.inFlight.sessionID
      this.inFlight.controller.abort()
      this.inFlight = undefined
      await this.driver.interruptSession(sessionID).catch(() => undefined)
    }
    await this.persistPending()
  }

  private hasActiveClients(): boolean {
    return this.clients.size > 0
  }

  private clearTimer(): void {
    if (!this.timer) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private async persistPending(): Promise<void> {
    await this.storage.savePending([...this.pending])
  }

  private intervalLabel(): string {
    const minutes = Math.round(this.options.intervalMs / 60_000)
    return minutes === 1 ? "1 minute" : `${minutes} minutes`
  }

  private providerLabel(): string {
    return this.options.providerID.toLowerCase() === "openai"
      ? "OpenAI"
      : this.options.providerID
  }

  private async publish(
    input: {
      kind: RetryNotice["kind"]
      attempt: number
      message: string
      sessionID?: string
      nextAttempt?: number
      nextAttemptAt?: number | null
    },
  ): Promise<void> {
    try {
      await this.driver.publish({
        id: randomUUID(),
        providerID: this.options.providerID,
        maxRetries: this.options.maxRetries,
        pendingSessions: this.pending.size,
        ...input,
      })
    } catch {
      // Notification subscribers are optional; their failure must not block retries.
    }
  }
}
