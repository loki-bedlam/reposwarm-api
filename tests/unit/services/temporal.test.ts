import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.LOG_LEVEL = 'silent'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn().mockResolvedValue({}) },
  Client: vi.fn().mockImplementation(() => ({
    workflow: {
      start: vi.fn(),
      getHandle: vi.fn()
    }
  }))
}))

// Import after mocks
const temporal = await import('../../../src/services/temporal.js')

describe('Temporal Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  describe('getWorkflow - failure extraction', () => {
    it('returns null for failed workflow fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found')
      })

      const result = await temporal.getWorkflow('nonexistent')
      expect(result).toBeNull()
    })

    it('extracts simple workflow failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-1', runId: 'r1' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Workflow execution failed'
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-1')
      expect(result).not.toBeNull()
      expect(result?.failure).toBeDefined()
      expect(result?.failure?.message).toBe('Workflow execution failed')
    })

    it('extracts activity failure with nested details', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-2', runId: 'r2' },
            type: { name: 'InvestigateSingleRepoWorkflow' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Activity task failed',
              cause: {
                activityFailureInfo: {
                  activityType: { name: 'cloneRepository' },
                  activityId: 'clone-1',
                  failure: {
                    message: 'Git clone failed: repository not found',
                    stackTrace: 'Error: Git clone failed\n    at Activity.cloneRepository (activity.ts:123)\n    at processTicksAndRejections'
                  }
                }
              }
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-2')
      expect(result?.failure).toBeDefined()
      expect(result?.failure?.message).toBe('Git clone failed: repository not found')
      expect(result?.failure?.source).toBe('Activity: cloneRepository')
      expect(result?.failure?.stackTrace).toContain('activity.ts:123')
    })

    it('extracts application failure info with non-retryable flag', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-3', runId: 'r3' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Application failure',
              applicationFailureInfo: {
                type: 'ValidationError',
                details: { message: 'Invalid input parameters' },
                nonRetryable: true
              }
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-3')
      expect(result?.failure).toBeDefined()
      expect(result?.failure?.message).toBe('[Non-retryable] Invalid input parameters')
    })

    it('extracts application failure info that is retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-4', runId: 'r4' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Application failure',
              applicationFailureInfo: {
                type: 'NetworkError',
                details: { message: 'Connection timeout' },
                nonRetryable: false
              }
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-4')
      expect(result?.failure).toBeDefined()
      expect(result?.failure?.message).toBe('Connection timeout')
    })

    it('handles activity failure with application failure nested', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-5', runId: 'r5' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Activity failed',
              cause: {
                activityFailureInfo: {
                  activityType: { name: 'processData' },
                  failure: {
                    message: 'Activity error',
                    cause: {
                      applicationFailureInfo: {
                        type: 'DataProcessingError',
                        details: { message: 'Invalid data format' },
                        nonRetryable: true
                      }
                    }
                  }
                }
              }
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-5')
      expect(result?.failure).toBeDefined()
      // Should extract the most specific error from nested application failure
      expect(result?.failure?.message).toBe('[Non-retryable] Invalid data format')
      expect(result?.failure?.source).toBe('Activity: processData')
    })

    it('handles workflow without failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-running', runId: 'r1' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
            startTime: '2026-01-01T00:00:00Z'
          }
        })
      })

      const result = await temporal.getWorkflow('wf-running')
      expect(result).not.toBeNull()
      expect(result?.failure).toBeUndefined()
    })

    it('handles missing activity type name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          workflowExecutionInfo: {
            execution: { workflowId: 'wf-6', runId: 'r6' },
            type: { name: 'Test' },
            status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
            startTime: '2026-01-01T00:00:00Z',
            failure: {
              message: 'Activity failed',
              cause: {
                activityFailureInfo: {
                  failure: {
                    message: 'Unknown activity error'
                  }
                }
              }
            }
          }
        })
      })

      const result = await temporal.getWorkflow('wf-6')
      expect(result?.failure).toBeDefined()
      expect(result?.failure?.message).toBe('Unknown activity error')
      expect(result?.failure?.source).toBe('Activity: unknown')
    })
  })
})
