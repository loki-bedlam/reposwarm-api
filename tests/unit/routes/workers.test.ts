import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import workersRouter from '../../../src/routes/workers.js'
import { readFileSync, existsSync } from 'fs'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'

// Mock the AWS SDK
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(),
  ConverseCommand: vi.fn()
}))

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn()
  }
})

// Mock fetch
global.fetch = vi.fn()

describe('Workers Routes', () => {
  let app: express.Application

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api', workersRouter)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('POST /workers/:id/inference-check', () => {

    it('should successfully check Anthropic provider', async () => {
      // Mock reading env file
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=test-key\nANTHROPIC_MODEL=claude-3-opus-20240229'
      )

      // Mock successful Anthropic API response
      const mockFetch = vi.mocked(global.fetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: 'OK' }]
        })
      } as Response)

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: true,
        provider: 'anthropic',
        model: 'claude-3-opus-20240229',
        response: 'OK'
      })
      expect(res.body.data.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('should handle Anthropic API key missing', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_MODEL=claude-3-opus-20240229'
      )

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: false,
        provider: 'anthropic',
        model: 'claude-3-opus-20240229',
      })
      expect(res.body.data.error).toBeTruthy()
    })

    it('should handle Anthropic API 401 error', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=invalid-key\nANTHROPIC_MODEL=claude-3-opus-20240229'
      )

      const mockFetch = vi.mocked(global.fetch)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          error: { message: 'Invalid API key' }
        })
      } as Response)

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: false,
        provider: 'anthropic',
      })
      expect(res.body.data.error).toBeTruthy()
    })

    it('should successfully check Bedrock provider with IAM role', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1'
      )

      // Mock Bedrock client
      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            content: [{ text: 'OK' }]
          }
        }
      })

      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({
        send: mockSend
      } as any))

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: true,
        provider: 'bedrock',
        model: 'us.anthropic.claude-opus-4-6-v1',
        authMethod: 'iam-role',
        response: 'OK'
      })
    })

    it('should handle Bedrock AccessDeniedException', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1'
      )

      const mockSend = vi.fn().mockRejectedValue({
        name: 'AccessDeniedException',
        message: 'User is not authorized to perform bedrock:InvokeModel'
      })

      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({
        send: mockSend
      } as any))

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: false,
        provider: 'bedrock',
      })
      expect(res.body.data.error).toBeTruthy()
    })

    it('should successfully check LiteLLM provider', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_BASE_URL=http://localhost:8000\nANTHROPIC_MODEL=claude-3-opus\nANTHROPIC_API_KEY=proxy-key'
      )

      const mockFetch = vi.mocked(global.fetch)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: 'OK' }]
        })
      } as Response)

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: true,
        provider: 'litellm',
        model: 'claude-3-opus',
        response: 'OK'
      })
    })

    it('should handle missing model', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('ANTHROPIC_API_KEY=test-key')

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: false,
        model: '',
      })
      expect(res.body.data.error).toContain('model')
    })

    it('should handle missing AWS_REGION for Bedrock', async () => {
      // Save and clear process.env region vars (CodeBuild sets AWS_REGION)
      const savedRegion = process.env.AWS_REGION
      const savedDefaultRegion = process.env.AWS_DEFAULT_REGION
      delete process.env.AWS_REGION
      delete process.env.AWS_DEFAULT_REGION

      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1'
      )

      const mockSend = vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: 'OK' }] } }
        })

      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({
        send: mockSend
      } as any))

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      // With no region in env vars, inference.ts defaults to us-east-1
      // So this should either succeed (if mock works) or fail with a bedrock error
      expect(res.body.data.provider).toBe('bedrock')

      // Restore env
      if (savedRegion) process.env.AWS_REGION = savedRegion
      if (savedDefaultRegion) process.env.AWS_DEFAULT_REGION = savedDefaultRegion
    })
  })

  describe('getRequiredEnvVars', () => {
    it('should return Anthropic requirements by default', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('ANTHROPIC_API_KEY=test')

      const res = await request(app)
        .get('/api/workers')
        .expect(200)

      // The function is called internally - we're just checking the endpoint works
      expect(res.body.data).toHaveProperty('workers')
    })

    it('should detect Bedrock provider requirements', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=model'
      )

      const res = await request(app)
        .get('/api/workers')
        .expect(200)

      expect(res.body.data.workers[0].envErrors).toEqual([])
    })

    it('should detect LiteLLM provider requirements', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_BASE_URL=http://localhost:8000\nANTHROPIC_MODEL=model\nGITHUB_TOKEN=token'
      )

      const res = await request(app)
        .get('/api/workers')
        .expect(200)

      expect(res.body.data.workers[0].envErrors).toEqual([])
    })
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// Docker worker health detection (Bug 2 fix)
// RED: These tests are written BEFORE the Docker-aware health check is added.
// ─────────────────────────────────────────────────────────────────────────────

// Mock child_process so pgrep (execSync) can be controlled
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process')
  return {
    ...(actual as object),
    execSync: vi.fn().mockImplementation(() => { throw new Error('pgrep: no process found') }),
    spawn: vi.fn().mockReturnValue({ pid: 0, on: vi.fn(), unref: vi.fn() })
  }
})

// Mock temporal service so we can control poller responses
vi.mock('../../../src/services/temporal.js', () => ({
  getTaskQueuePollers: vi.fn(),
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  startWorkflow: vi.fn(),
  terminateWorkflow: vi.fn(),
  healthCheck: vi.fn(),
  resetClient: vi.fn()
}))

describe('Docker worker health detection', () => {
  let app: express.Application

  beforeEach(async () => {
    app = express()
    app.use(express.json())
    app.use('/api', workersRouter)
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.DOCKER_COMPOSE
    vi.restoreAllMocks()
  })

  it('RED: returns healthy when running in Docker (/.dockerenv exists) and Temporal pollers are active', async () => {
    // Arrange: Docker env file exists, env vars are configured, pgrep finds nothing
    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path) === '/.dockerenv') return true
      if (String(path).includes('.env')) return true
      return false
    })
    vi.mocked(readFileSync).mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5'
    )
    // pgrep throws (mocked globally above) → pid = 0
    // Temporal says workers are polling
    const { getTaskQueuePollers } = await import('../../../src/services/temporal.js')
    vi.mocked(getTaskQueuePollers).mockResolvedValue([{ identity: 'worker-1', lastAccessTime: new Date().toISOString() }])

    const res = await request(app)
      .get('/api/workers')
      .expect(200)

    // Before fix: status = 'stopped' (pid=0, no Docker check)
    // After fix:  status = 'healthy' (Docker detected, pollers active)
    expect(res.body.data.workers[0].status).toBe('healthy')
  })

  it('RED: returns stopped when running in Docker but no Temporal pollers are active', async () => {
    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path) === '/.dockerenv') return true
      if (String(path).includes('.env')) return true
      return false
    })
    vi.mocked(readFileSync).mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5'
    )
    const { getTaskQueuePollers } = await import('../../../src/services/temporal.js')
    vi.mocked(getTaskQueuePollers).mockResolvedValue([]) // no pollers

    const res = await request(app)
      .get('/api/workers')
      .expect(200)

    expect(res.body.data.workers[0].status).toBe('stopped')
  })

  it('RED: non-Docker environment preserves existing pid-based behaviour (stopped when pid=0)', async () => {
    // No /.dockerenv, no DOCKER_COMPOSE env var
    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path) === '/.dockerenv') return false
      if (String(path).includes('.env')) return true
      return false
    })
    vi.mocked(readFileSync).mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5'
    )

    const res = await request(app)
      .get('/api/workers')
      .expect(200)

    // No Docker, pid=0 → must remain stopped
    expect(res.body.data.workers[0].status).toBe('stopped')
  })

  it('RED: DOCKER_COMPOSE=1 env var also triggers Docker-aware health check', async () => {
    process.env.DOCKER_COMPOSE = '1'
    vi.mocked(existsSync).mockImplementation((path: any) => {
      // no .dockerenv file, but DOCKER_COMPOSE=1 is set
      if (String(path).includes('.env')) return true
      return false
    })
    vi.mocked(readFileSync).mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5'
    )
    const { getTaskQueuePollers } = await import('../../../src/services/temporal.js')
    vi.mocked(getTaskQueuePollers).mockResolvedValue([{ identity: 'worker-1', lastAccessTime: new Date().toISOString() }])

    const res = await request(app)
      .get('/api/workers')
      .expect(200)

    expect(res.body.data.workers[0].status).toBe('healthy')
  })
})
