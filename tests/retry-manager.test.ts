import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CONTINUATION_TEXT,
  RetryManager,
  type RetryManagerDriver,
  type RetryManagerStorage,
} from "../src/retry-manager.js"
import type { RetryNotice } from "../src/rpc.js"

const INTERVAL_MS = 30 * 60_000
const HEARTBEAT_TIMEOUT_MS = 45_000

function createHarness(initialPending: string[] = []) {
  let stored = [...initialPending]
  const notices: RetryNotice[] = []
  const continueSession = vi.fn(
    async (_sessionID: string, _attempt: number, _messageID: string, _signal: AbortSignal) => undefined,
  )
  const interruptSession = vi.fn(async () => undefined)

  const storage: RetryManagerStorage = {
    async loadPending() {
      return [...stored]
    },
    async savePending(sessionIDs) {
      stored = [...sessionIDs]
    },
  }

  const driver: RetryManagerDriver = {
    async waitForIdle() {},
    continueSession,
    interruptSession,
    async publish(notice) {
      notices.push(notice)
    },
  }

  const manager = new RetryManager(
    {
      providerID: "openai",
      intervalMs: INTERVAL_MS,
      maxRetries: 10,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    },
    storage,
    driver,
  )

  return {
    manager,
    notices,
    continueSession,
    interruptSession,
    getStored: () => [...stored],
  }
}

describe("RetryManager", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-16T00:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses the minimal continuation prompt", () => {
    expect(CONTINUATION_TEXT).toBe("Continue")
  })

  it("waits 30 minutes before the first retry and reports the retry number", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })

    await harness.manager.quotaFailure("ses_one")

    expect(harness.continueSession).not.toHaveBeenCalled()
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "waiting",
      attempt: 1,
      maxRetries: 10,
      message: expect.stringContaining("Retry 1/10"),
    })

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
    expect(harness.continueSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.continueSession).toHaveBeenCalledWith(
      "ses_one",
      1,
      expect.stringMatching(/^msg_/),
      expect.any(AbortSignal),
    )
  })

  it("reports recovery with the number of delayed attempts and clears pending work", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "desktop-1", active: true, surface: "desktop" })
    await harness.manager.quotaFailure("ses_one")

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    await harness.manager.executionSucceeded("ses_one")

    expect(harness.getStored()).toEqual([])
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "recovered",
      attempt: 1,
      message: expect.stringContaining("retry 1/10"),
    })
  })

  it("announces recovery as soon as the provider accepts a retry request", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })
    await harness.manager.quotaFailure("ses_one")
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    await harness.manager.providerRequestAccepted("ses_one")

    expect(harness.notices.at(-1)).toMatchObject({
      kind: "recovered",
      attempt: 1,
      message: expect.stringContaining("retry 1/10"),
    })

    // A later rate limit during the same continued task starts a new cycle.
    await harness.manager.quotaFailure("ses_one")
    expect(harness.notices.at(-1)).toMatchObject({
      kind: "waiting",
      attempt: 1,
    })
  })

  it("stops after ten delayed retries and reports exhaustion", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })
    await harness.manager.quotaFailure("ses_one")

    for (let attempt = 1; attempt <= 10; attempt++) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(harness.continueSession).toHaveBeenCalledTimes(attempt)
      await harness.manager.quotaFailure("ses_one")
    }

    expect(harness.notices.at(-1)).toMatchObject({
      kind: "exhausted",
      attempt: 10,
      maxRetries: 10,
      message: expect.stringContaining("10/10"),
    })
    expect(harness.manager.snapshot().nextAttemptAt).toBeNull()
    expect(harness.getStored()).toEqual(["ses_one"])
  })

  it("cancels the wait when the last UI client leaves and probes immediately on return", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "desktop-1", active: true, surface: "desktop" })
    await harness.manager.quotaFailure("ses_one")

    await harness.manager.heartbeat({ clientID: "desktop-1", active: false, surface: "desktop" })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(harness.continueSession).not.toHaveBeenCalled()
    expect(harness.getStored()).toEqual(["ses_one"])

    await harness.manager.heartbeat({ clientID: "desktop-2", active: true, surface: "desktop" })
    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1))
    expect(harness.continueSession).toHaveBeenCalledTimes(1)
    expect(harness.continueSession).toHaveBeenCalledWith(
      "ses_one",
      0,
      expect.stringMatching(/^msg_/),
      expect.any(AbortSignal),
    )
  })

  it("cancels a queued retry when the user continues the session manually", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })
    await harness.manager.quotaFailure("ses_one")

    await harness.manager.userPrompt("ses_one")
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(harness.continueSession).not.toHaveBeenCalled()
    expect(harness.getStored()).toEqual([])
  })

  it("serializes pending sessions after one successful probe", async () => {
    const harness = createHarness()
    await harness.manager.restore()
    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })
    await harness.manager.quotaFailure("ses_one")
    await harness.manager.quotaFailure("ses_two")

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(harness.continueSession).toHaveBeenCalledTimes(1)
    expect(harness.continueSession.mock.calls[0]?.[0]).toBe("ses_one")

    await harness.manager.executionSucceeded("ses_one")
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.continueSession).toHaveBeenCalledTimes(2)
    expect(harness.continueSession.mock.calls[1]?.[0]).toBe("ses_two")
    expect(harness.continueSession.mock.calls[1]?.[1]).toBe(0)
  })

  it("restores pending sessions without restoring a wait deadline", async () => {
    const harness = createHarness(["ses_one"])
    await harness.manager.restore()
    expect(harness.manager.snapshot().nextAttemptAt).toBeNull()

    await harness.manager.heartbeat({ clientID: "tui-1", active: true, surface: "tui" })
    await vi.waitFor(() => expect(harness.continueSession).toHaveBeenCalledTimes(1))
    expect(harness.continueSession).toHaveBeenCalledTimes(1)
    expect(harness.continueSession.mock.calls[0]?.[1]).toBe(0)
  })
})
