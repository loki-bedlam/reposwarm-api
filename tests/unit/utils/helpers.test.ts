import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatStartedAgo, isWorkflowStale } from '../../../src/utils/helpers.js'

describe('Stale Workflow Detection Helpers', () => {
  beforeEach(() => {
    // Mock Date.now to return a fixed timestamp: 2026-03-08T12:00:00.000Z
    const fixedTime = new Date('2026-03-08T12:00:00.000Z').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(fixedTime)
  })

  afterEach(() => {
    // Restore original Date.now
    vi.restoreAllMocks()
  })

  // ─── formatStartedAgo ───────────────────────────────────────

  describe('formatStartedAgo', () => {
    it('should format workflow that just started (0 minutes)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      const startTime = '2026-03-08T12:00:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('0m ago')
    })

    it('should format workflow running for 5 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:55:00.000Z (5 minutes ago)
      const startTime = '2026-03-08T11:55:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('5m ago')
    })

    it('should format workflow running for 45 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:15:00.000Z (45 minutes ago)
      const startTime = '2026-03-08T11:15:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('45m ago')
    })

    it('should format workflow running for exactly 1 hour (no remaining minutes)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:00:00.000Z (1 hour ago)
      const startTime = '2026-03-08T11:00:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('1h ago')
    })

    it('should format workflow running for 2 hours with remaining minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('2h ago')
    })

    it('should format workflow running for 2 hours 30 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T09:30:00.000Z (2 hours 30 minutes ago)
      const startTime = '2026-03-08T09:30:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('2h 30m ago')
    })

    it('should format workflow running for 3 hours 15 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T08:45:00.000Z (3 hours 15 minutes ago)
      const startTime = '2026-03-08T08:45:00.000Z'
      expect(formatStartedAgo(startTime)).toBe('3h 15m ago')
    })

    it('should handle seconds correctly (rounds down to minutes)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:55:30.000Z (4 minutes 30 seconds ago -> 4m ago)
      const startTime = '2026-03-08T11:55:30.000Z'
      expect(formatStartedAgo(startTime)).toBe('4m ago')
    })
  })

  // ─── isWorkflowStale ────────────────────────────────────────

  describe('isWorkflowStale', () => {
    it('should return false for workflow running for 5 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:55:00.000Z (5 minutes ago)
      const startTime = '2026-03-08T11:55:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(false)
    })

    it('should return true for workflow running for 45 minutes', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:15:00.000Z (45 minutes ago)
      const startTime = '2026-03-08T11:15:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(true)
    })

    it('should return true for workflow running for 2 hours', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(true)
    })

    it('should return false for completed workflow (regardless of duration)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('Completed', startTime)).toBe(false)
    })

    it('should return false for failed workflow', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('Failed', startTime)).toBe(false)
    })

    it('should return false for workflow that just started (0 minutes)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      const startTime = '2026-03-08T12:00:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(false)
    })

    it('should return true for workflow running for exactly 31 minutes (boundary test)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:29:00.000Z (31 minutes ago)
      const startTime = '2026-03-08T11:29:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(true)
    })

    it('should return false for workflow running for exactly 30 minutes (boundary test)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T11:30:00.000Z (30 minutes ago)
      const startTime = '2026-03-08T11:30:00.000Z'
      expect(isWorkflowStale('Running', startTime)).toBe(false)
    })

    it('should return false for Terminated workflow (non-Running status)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('Terminated', startTime)).toBe(false)
    })

    it('should return false for Cancelled workflow (non-Running status)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('Cancelled', startTime)).toBe(false)
    })

    it('should return false for TimedOut workflow (non-Running status)', () => {
      // Current time: 2026-03-08T12:00:00.000Z
      // Started at: 2026-03-08T10:00:00.000Z (2 hours ago)
      const startTime = '2026-03-08T10:00:00.000Z'
      expect(isWorkflowStale('TimedOut', startTime)).toBe(false)
    })
  })
})
