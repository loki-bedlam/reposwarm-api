import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.API_BEARER_TOKEN = 'test-bearer-token'
process.env.LOG_LEVEL = 'silent'

const { mockSend, mockWorkflowStart, mockTerminate, mockFetch } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWorkflowStart: vi.fn().mockResolvedValue({ workflowId: 'test-wf' }),
  mockTerminate: vi.fn(),
  mockFetch: vi.fn()
}))

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn().mockReturnValue({
      verify: vi.fn().mockRejectedValue(new Error('Invalid'))
    })
  }
}))

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({}))
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({ send: mockSend }) },
  ScanCommand: vi.fn().mockImplementation((p) => ({ _type: 'Scan', ...p })),
  GetCommand: vi.fn().mockImplementation((p) => ({ _type: 'Get', ...p })),
  PutCommand: vi.fn().mockImplementation((p) => ({ _type: 'Put', ...p })),
  DeleteCommand: vi.fn().mockImplementation((p) => ({ _type: 'Delete', ...p })),
  QueryCommand: vi.fn().mockImplementation((p) => ({ _type: 'Query', ...p })),
  UpdateCommand: vi.fn().mockImplementation((p) => ({ _type: 'Update', ...p }))
}))

vi.mock('@aws-sdk/client-codecommit', () => ({
  CodeCommitClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  ListRepositoriesCommand: vi.fn(),
  BatchGetRepositoriesCommand: vi.fn()
}))

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn().mockResolvedValue({}) },
  Client: vi.fn().mockImplementation(() => ({
    workflow: {
      start: mockWorkflowStart,
      getHandle: vi.fn().mockReturnValue({ terminate: mockTerminate })
    }
  }))
}))

vi.stubGlobal('fetch', mockFetch)

import supertest from 'supertest'
import { createApp } from '../../src/app.js'

const app = createApp()
const request = supertest(app)
const AUTH = { Authorization: 'Bearer test-bearer-token' }

beforeEach(() => {
  vi.clearAllMocks()
  mockSend.mockReset()
  mockFetch.mockReset()
})

// ============ HEALTH ============

describe('GET /health', () => {
  it('returns healthy without auth', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] }) // DynamoDB health
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // Temporal health
    const res = await request.get('/health')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBeDefined()
  })
})

// ============ AUTH ============

describe('Authentication', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request.get('/repos')
    expect(res.status).toBe(401)
  })

  it('rejects invalid bearer token', async () => {
    const res = await request.get('/repos').set('Authorization', 'Bearer wrong-token')
    expect(res.status).toBe(401)
  })

  it('accepts valid bearer token', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
    const res = await request.get('/repos').set(AUTH)
    expect(res.status).toBe(200)
  })
})

// ============ REPOS ============

describe('GET /repos', () => {
  it('returns list of repos', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: 'my-repo', analysis_timestamp: 0, url: 'https://example.com', source: 'GitHub', enabled: true, status: 'active' }
      ],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/repos').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('my-repo')
  })

  it('filters out internal entries', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: 'my-repo', analysis_timestamp: 0, url: 'u', source: 'GitHub', enabled: true },
        { repository_name: '_config', analysis_timestamp: 0 },
        { repository_name: '_prompt_test', analysis_timestamp: 0 }
      ],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/repos').set(AUTH)
    expect(res.body.data).toHaveLength(1)
  })

  it('handles pagination', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ repository_name: 'repo1', analysis_timestamp: 0, url: 'u', source: 'GitHub' }],
        LastEvaluatedKey: { repository_name: { S: 'repo1' } }
      })
      .mockResolvedValueOnce({
        Items: [{ repository_name: 'repo2', analysis_timestamp: 0, url: 'u', source: 'GitHub' }],
        LastEvaluatedKey: undefined
      })
    const res = await request.get('/repos').set(AUTH)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /repos', () => {
  it('creates a repo', async () => {
    mockSend.mockResolvedValueOnce({}) // PutCommand
    const res = await request.post('/repos').set(AUTH).send({ name: 'new-repo', url: 'https://github.com/test' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('new-repo')
  })

  it('rejects missing name', async () => {
    const res = await request.post('/repos').set(AUTH).send({ url: 'https://example.com' })
    expect(res.status).toBe(400)
  })

  it('rejects missing url', async () => {
    const res = await request.post('/repos').set(AUTH).send({ name: 'test' })
    expect(res.status).toBe(400)
  })
})

describe('GET /repos/:name', () => {
  it('returns repo by name', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { repository_name: 'test', analysis_timestamp: 0, url: 'u', source: 'GitHub', enabled: true, status: 'active' }
    })
    const res = await request.get('/repos/test').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('test')
  })

  it('returns 404 for missing repo', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })
    const res = await request.get('/repos/nonexistent').set(AUTH)
    expect(res.status).toBe(404)
  })
})

describe('PUT /repos/:name', () => {
  it('updates a repo', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: 'test', analysis_timestamp: 0, url: 'u', source: 'GitHub', enabled: true, status: 'active' } })
      .mockResolvedValueOnce({}) // UpdateCommand
    const res = await request.put('/repos/test').set(AUTH).send({ enabled: false })
    expect(res.status).toBe(200)
  })

  it('returns 404 for missing repo', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })
    const res = await request.put('/repos/missing').set(AUTH).send({ enabled: false })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /repos/:name', () => {
  it('deletes a repo', async () => {
    mockSend.mockResolvedValueOnce({})
    const res = await request.delete('/repos/test').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
  })
})

// ============ WORKFLOWS ============

describe('GET /workflows', () => {
  it('lists workflows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        executions: [
          { execution: { workflowId: 'wf-1', runId: 'r1' }, type: { name: 'InvestigateSingleRepoWorkflow' }, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING', startTime: '2026-01-01T00:00:00Z' }
        ]
      })
    })
    const res = await request.get('/workflows').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.executions).toHaveLength(1)
    expect(res.body.data.executions[0].status).toBe('Running')
  })
})

describe('GET /workflows/:id', () => {
  it('gets workflow detail', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowExecutionInfo: { execution: { workflowId: 'wf-1', runId: 'r1' }, type: { name: 'Test' }, status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED', startTime: '2026-01-01T00:00:00Z' }
      })
    })
    const res = await request.get('/workflows/wf-1').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('Completed')
  })

  it('extracts activity failure details', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowExecutionInfo: {
          execution: { workflowId: 'wf-failed', runId: 'r1' },
          type: { name: 'InvestigateSingleRepoWorkflow' },
          status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
          startTime: '2026-01-01T00:00:00Z',
          closeTime: '2026-01-01T00:05:00Z',
          failure: {
            message: 'Activity task failed',
            cause: {
              activityFailureInfo: {
                activityType: { name: 'cloneRepository' },
                failure: {
                  message: 'Git clone failed: exit code 128',
                  stackTrace: 'at cloneRepository (activity.ts:42)'
                }
              }
            }
          }
        }
      })
    })
    const res = await request.get('/workflows/wf-failed').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('Failed')
    expect(res.body.data.failure).toBeDefined()
    expect(res.body.data.failure.message).toBe('Git clone failed: exit code 128')
    expect(res.body.data.failure.source).toBe('Activity: cloneRepository')
  })

  it('extracts application failure details', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowExecutionInfo: {
          execution: { workflowId: 'wf-app-failed', runId: 'r1' },
          type: { name: 'TestWorkflow' },
          status: 'WORKFLOW_EXECUTION_STATUS_FAILED',
          startTime: '2026-01-01T00:00:00Z',
          failure: {
            message: 'Application error',
            applicationFailureInfo: {
              type: 'ValidationError',
              details: { message: 'Invalid repository URL' },
              nonRetryable: true
            }
          }
        }
      })
    })
    const res = await request.get('/workflows/wf-app-failed').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.failure).toBeDefined()
    expect(res.body.data.failure.message).toBe('[Non-retryable] Invalid repository URL')
  })
})

describe('GET /workflows/status', () => {
  it('gets workflow status by query param', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowExecutionInfo: { execution: { workflowId: 'wf-test', runId: 'r1' }, type: { name: 'Test' }, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING', startTime: '2026-01-01T00:00:00Z' }
      })
    })
    const res = await request.get('/workflows/status?id=wf-test').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('Running')
  })

  it('handles workflow IDs with special characters (colons, slashes)', async () => {
    const workflowId = 'investigate-single-https://github.com/jonschlinkert/is-odd-1772959352'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workflowExecutionInfo: {
          execution: { workflowId, runId: 'r1' },
          type: { name: 'InvestigateSingleRepoWorkflow' },
          status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
          startTime: '2026-01-01T00:00:00Z'
        }
      })
    })
    const res = await request.get(`/workflows/status?id=${encodeURIComponent(workflowId)}`).set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.workflowId).toBe(workflowId)
    expect(res.body.data.status).toBe('Running')
    // Verify that the fetch was called with URL-encoded workflow ID
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(workflowId))
    )
  })

  it('returns 400 if workflow id query param is missing', async () => {
    const res = await request.get('/workflows/status').set(AUTH)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Missing workflow id')
  })

  it('returns 404 for non-existent workflow', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found')
    })
    const res = await request.get('/workflows/status?id=nonexistent').set(AUTH)
    expect(res.status).toBe(404)
  })
})

describe('GET /workflows/:id/history', () => {
  it('gets workflow history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        history: { events: [{ eventId: '1', eventTime: '2026-01-01T00:00:00Z', eventType: 'WorkflowExecutionStarted' }] }
      })
    })
    const res = await request.get('/workflows/wf-1/history').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(1)
  })
})

describe('POST /workflows/:id/terminate', () => {
  it('terminates a workflow', async () => {
    const res = await request.post('/workflows/wf-1/terminate').set(AUTH).send({ reason: 'test' })
    expect(res.status).toBe(200)
    expect(res.body.data.terminated).toBe(true)
  })
})

// ============ INVESTIGATE ============

describe('POST /investigate/single', () => {
  it('starts a single investigation', async () => {
    mockSend.mockResolvedValueOnce({ Item: { repository_name: 'test', url: 'https://example.com' } })
    const res = await request.post('/investigate/single').set(AUTH).send({ repo_name: 'test' })
    expect(res.status).toBe(202)
    expect(res.body.data.workflowId).toContain('investigate-single-test')
  })

  it('rejects missing repo_name', async () => {
    const res = await request.post('/investigate/single').set(AUTH).send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /investigate/daily', () => {
  it('starts daily investigation', async () => {
    const res = await request.post('/investigate/daily').set(AUTH)
    expect(res.status).toBe(202)
    expect(res.body.data.workflowId).toContain('investigate-daily')
  })
})

// ============ WIKI ============

describe('GET /wiki', () => {
  it('lists wiki repos', async () => {
    mockSend
      .mockResolvedValueOnce({ // _result_ scan
        Items: [{ repository_name: '_result_myrepo_hl_overview_abc_1', analysis_timestamp: 1, step_name: 'hl_overview', created_at: '2026-01-01' }],
        LastEvaluatedKey: undefined
      })
      .mockResolvedValueOnce({ // repo list scan
        Items: [{ repository_name: 'myrepo', analysis_timestamp: 0, url: 'u', source: 'GitHub' }],
        LastEvaluatedKey: undefined
      })
    const res = await request.get('/wiki').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.repos).toHaveLength(1)
  })
})

describe('GET /wiki/:repo', () => {
  it('lists sections', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ repository_name: '_result_myrepo_hl_overview_abc_1', step_name: 'hl_overview', created_at: '2026-01-01' }],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/wiki/myrepo').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.sections).toHaveLength(1)
  })

  it('returns 404 for empty repo', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
    const res = await request.get('/wiki/nonexistent').set(AUTH)
    expect(res.status).toBe(404)
  })
})

describe('GET /wiki/:repo/:section', () => {
  it('returns section content', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ repository_name: '_result_myrepo_hl_overview_abc_1', step_name: 'hl_overview', result_content: '# Overview\nTest content', created_at: '2026-01-01' }],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/wiki/myrepo/hl_overview').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.content).toContain('Overview')
  })

  it('returns 404 for missing section', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
    const res = await request.get('/wiki/myrepo/missing').set(AUTH)
    expect(res.status).toBe(404)
  })
})

// ============ PROMPTS ============

describe('GET /prompts', () => {
  it('lists prompts sorted by order', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: '_prompt_deps', analysis_timestamp: 0, content: 'c', description: 'd', order_num: 2, enabled: true, prompt_type: 'shared', version: 1 },
        { repository_name: '_prompt_overview', analysis_timestamp: 0, content: 'c', description: 'd', order_num: 1, enabled: true, prompt_type: 'shared', version: 1 }
      ],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/prompts').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data[0].name).toBe('overview')
    expect(res.body.data[1].name).toBe('deps')
  })

  it('filters by type', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: '_prompt_shared1', analysis_timestamp: 0, content: 'c', order_num: 1, prompt_type: 'shared', version: 1 },
        { repository_name: '_prompt_backend1', analysis_timestamp: 0, content: 'c', order_num: 2, prompt_type: 'backend', version: 1 },
        { repository_name: '_prompt_frontend1', analysis_timestamp: 0, content: 'c', order_num: 3, prompt_type: 'frontend', version: 1 }
      ],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/prompts?type=backend').set(AUTH)
    expect(res.body.data).toHaveLength(2) // shared + backend
  })

  it('filters by enabled', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: '_prompt_active', analysis_timestamp: 0, content: 'c', order_num: 1, prompt_type: 'shared', version: 1, enabled: true },
        { repository_name: '_prompt_inactive', analysis_timestamp: 0, content: 'c', order_num: 2, prompt_type: 'shared', version: 1, enabled: false }
      ],
      LastEvaluatedKey: undefined
    })
    const res = await request.get('/prompts?enabled=true').set(AUTH)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('active')
  })
})

describe('POST /prompts', () => {
  it('creates a prompt', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: undefined }) // getPrompt (check exists)
      .mockResolvedValueOnce({}) // putPrompt
      .mockResolvedValueOnce({}) // putPromptVersion
    const res = await request.post('/prompts').set(AUTH).send({ name: 'new_prompt', content: 'Analyze...', description: 'A test prompt' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('new_prompt')
    expect(res.body.data.version).toBe(1)
  })

  it('rejects duplicate name', async () => {
    mockSend.mockResolvedValueOnce({ Item: { repository_name: '_prompt_existing', analysis_timestamp: 0 } })
    const res = await request.post('/prompts').set(AUTH).send({ name: 'existing', content: 'c' })
    expect(res.status).toBe(409)
  })

  it('rejects missing content', async () => {
    const res = await request.post('/prompts').set(AUTH).send({ name: 'test' })
    expect(res.status).toBe(400)
  })

  it('rejects missing name', async () => {
    const res = await request.post('/prompts').set(AUTH).send({ content: 'c' })
    expect(res.status).toBe(400)
  })
})

describe('GET /prompts/:name', () => {
  it('returns prompt', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'c', description: 'd', order_num: 1, enabled: true, prompt_type: 'shared', version: 2 }
    })
    const res = await request.get('/prompts/test').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('test')
    expect(res.body.data.version).toBe(2)
  })

  it('returns 404', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })
    const res = await request.get('/prompts/missing').set(AUTH)
    expect(res.status).toBe(404)
  })
})

describe('PUT /prompts/:name', () => {
  it('updates prompt and creates new version', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'old', description: 'd', order_num: 1, enabled: true, prompt_type: 'shared', version: 2 } })
      .mockResolvedValueOnce({}) // putPrompt
      .mockResolvedValueOnce({}) // putPromptVersion
    const res = await request.put('/prompts/test').set(AUTH).send({ content: 'new content', message: 'updated' })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(3)
    expect(res.body.data.content).toBe('new content')
  })

  it('rejects empty update', async () => {
    mockSend.mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'old', description: 'd', order_num: 1, enabled: true, prompt_type: 'shared', version: 1 } })
    const res = await request.put('/prompts/test').set(AUTH).send({})
    expect(res.status).toBe(400)
  })

  it('updates metadata without creating new version', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'old', description: 'd', order_num: 1, enabled: true, prompt_type: 'shared', version: 2 } })
      .mockResolvedValueOnce({}) // putPrompt
    const res = await request.put('/prompts/test').set(AUTH).send({ description: 'new desc' })
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBe('new desc')
    expect(res.body.data.version).toBe(2) // version unchanged
  })
})

describe('DELETE /prompts/:name', () => {
  it('deletes prompt', async () => {
    mockSend.mockResolvedValueOnce({})
    const res = await request.delete('/prompts/test').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
  })
})

describe('PUT /prompts/:name/order', () => {
  it('updates order', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'c', order_num: 5, enabled: true, prompt_type: 'shared', version: 1 } })
      .mockResolvedValueOnce({})
    const res = await request.put('/prompts/test/order').set(AUTH).send({ position: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data.order).toBe(3)
  })

  it('rejects invalid position', async () => {
    mockSend.mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0 } })
    const res = await request.put('/prompts/test/order').set(AUTH).send({ position: 0 })
    expect(res.status).toBe(400)
  })

  it('rejects non-number position', async () => {
    mockSend.mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0 } })
    const res = await request.put('/prompts/test/order').set(AUTH).send({ position: 'abc' })
    expect(res.status).toBe(400)
  })
})

describe('PUT /prompts/:name/toggle', () => {
  it('toggles enabled state', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'c', order_num: 1, enabled: true, prompt_type: 'shared', version: 1 } })
      .mockResolvedValueOnce({})
    const res = await request.put('/prompts/test/toggle').set(AUTH).send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.data.enabled).toBe(false)
  })
})

describe('PUT /prompts/:name/context', () => {
  it('updates context deps', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'c', order_num: 1, enabled: true, prompt_type: 'shared', version: 1 } })
      .mockResolvedValueOnce({})
    const res = await request.put('/prompts/test/context').set(AUTH).send({ context: [{ type: 'step', val: 'hl_overview' }] })
    expect(res.status).toBe(200)
    expect(res.body.data.context).toHaveLength(1)
  })
})

describe('GET /prompts/:name/versions', () => {
  it('lists versions', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { repository_name: '_prompt_test', analysis_timestamp: 2, content: 'v2', created_by: 'cli', created_at: '2026-02-02' },
        { repository_name: '_prompt_test', analysis_timestamp: 1, content: 'v1', created_by: 'api', created_at: '2026-01-01' }
      ]
    })
    const res = await request.get('/prompts/test/versions').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].version).toBe(2)
  })
})

describe('GET /prompts/:name/versions/:version', () => {
  it('gets specific version', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { repository_name: '_prompt_test', analysis_timestamp: 1, content: 'v1 content', created_by: 'api', created_at: '2026-01-01' }
    })
    const res = await request.get('/prompts/test/versions/1').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.content).toBe('v1 content')
  })

  it('returns 404 for missing version', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })
    const res = await request.get('/prompts/test/versions/99').set(AUTH)
    expect(res.status).toBe(404)
  })
})

describe('POST /prompts/:name/rollback', () => {
  it('rolls back to previous version', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'v3', order_num: 1, enabled: true, prompt_type: 'shared', version: 3 } })
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 1, content: 'v1 content', created_by: 'api' } })
      .mockResolvedValueOnce({}) // putPrompt
      .mockResolvedValueOnce({}) // putPromptVersion
    const res = await request.post('/prompts/test/rollback').set(AUTH).send({ toVersion: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(4)
    expect(res.body.data.content).toBe('v1 content')
  })

  it('returns 404 for missing target version', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, version: 3 } })
      .mockResolvedValueOnce({ Item: undefined })
    const res = await request.post('/prompts/test/rollback').set(AUTH).send({ toVersion: 99 })
    expect(res.status).toBe(404)
  })
})

describe('PUT /prompts/:name/rollback', () => {
  it('rolls back via PUT', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 0, content: 'v3', order_num: 1, enabled: true, prompt_type: 'shared', version: 3 } })
      .mockResolvedValueOnce({ Item: { repository_name: '_prompt_test', analysis_timestamp: 1, content: 'v1 content', created_by: 'api' } })
      .mockResolvedValueOnce({}) // putPrompt
      .mockResolvedValueOnce({}) // putPromptVersion
    const res = await request.put('/prompts/test/rollback').set(AUTH).send({ toVersion: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(4)
    expect(res.body.data.content).toBe('v1 content')
  })
})

describe('POST /prompts/export', () => {
  it('exports prompts and types', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ repository_name: '_prompt_test', analysis_timestamp: 0, content: 'c', order_num: 1, prompt_type: 'shared', version: 1 }], LastEvaluatedKey: undefined })
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined }) // types
      .mockResolvedValueOnce({ Items: [] }) // versions for test
    const res = await request.post('/prompts/export').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.prompts).toBeDefined()
  })
})

// ============ CONFIG ============

describe('GET /config', () => {
  it('returns config', async () => {
    mockSend.mockResolvedValueOnce({ Item: { defaultModel: 'claude', chunkSize: 10 } })
    const res = await request.get('/config').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data).toBeDefined()
  })

  it('returns defaults when no config stored', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })
    const res = await request.get('/config').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.data.defaultModel).toBeDefined()
  })
})

describe('PUT /config', () => {
  it('updates config', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: undefined }) // getConfig
      .mockResolvedValueOnce({}) // putConfig
      .mockResolvedValueOnce({ Item: { defaultModel: 'new-model', chunkSize: 10 } }) // getConfig again
    const res = await request.put('/config').set(AUTH).send({ defaultModel: 'new-model' })
    expect(res.status).toBe(200)
  })
})
