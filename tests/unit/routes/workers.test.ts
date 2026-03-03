import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import workersRouter from '../../../src/routes/workers.js'
import { readFileSync, existsSync } from 'fs'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'

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
    const mockEnvPath = '/home/ubuntu/reposwarm/worker/.env'

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
        authMethod: 'api-key',
        response: 'OK'
      })
      expect(res.body.data.latencyMs).toBeGreaterThan(0)

      // Verify fetch was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'test-key',
            'anthropic-version': '2023-06-01'
          }),
          body: expect.stringContaining('Say OK')
        })
      )
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
        error: 'ANTHROPIC_API_KEY not set',
        hint: 'Set your Anthropic API key in worker env vars'
      })
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
        error: 'Invalid API key',
        hint: 'Invalid Anthropic API key'
      })
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
        error: 'User is not authorized to perform bedrock:InvokeModel',
        hint: 'IAM role/user needs bedrock:InvokeModel permission for the model'
      })
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
        authMethod: 'api-key',
        response: 'OK'
      })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'proxy-key'
          })
        })
      )
    })

    it('should handle missing model', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('ANTHROPIC_API_KEY=test-key')

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      expect(res.body.data).toMatchObject({
        success: false,
        provider: 'anthropic',
        model: '',
        error: 'No model specified',
        hint: 'Set ANTHROPIC_MODEL or CLAUDE_MODEL env var'
      })
    })

    it('should handle missing AWS_REGION for Bedrock', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1'
      )

      // Mock BedrockRuntimeClient to throw error when region is undefined
      const mockSend = vi.fn().mockRejectedValue(new Error('client.send is not a function'))
      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({
        send: mockSend
      } as any))

      const res = await request(app)
        .post('/api/workers/worker-1/inference-check')
        .expect(200)

      // The actual behavior when region is missing is that the client constructor
      // still succeeds but then fails when trying to send the command
      expect(res.body.data).toMatchObject({
        success: false,
        provider: 'bedrock',
        model: 'us.anthropic.claude-opus-4-6-v1',
        error: expect.stringContaining('client.send'),
        hint: 'Check credentials and network connectivity'
      })
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