import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { readFileSync, existsSync } from 'fs'

// Mock AWS SDK
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(),
  ConverseCommand: vi.fn()
}))

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  }
})

// Mock fetch
global.fetch = vi.fn()

// Import AFTER mocks are set up
import {
  readWorkerEnv,
  detectProvider,
  detectAuthMethod,
  detectModel,
  detectRegion,
  infer,
} from '../../../src/utils/inference.js'

describe('Inference Module', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    // Save env vars we might modify
    for (const key of [
      'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE',
      'AWS_REGION', 'AWS_DEFAULT_REGION', 'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL', 'MODEL_ID',
    ]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val
      else delete process.env[key]
    }
  })

  // ─── readWorkerEnv ──────────────────────────────────────────

  describe('readWorkerEnv', () => {
    it('should return empty object when .env does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      expect(readWorkerEnv()).toEqual({})
    })

    it('should parse key=value pairs', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'KEY1=value1\nKEY2=value2\nKEY3=value3'
      )
      const env = readWorkerEnv()
      expect(env).toEqual({ KEY1: 'value1', KEY2: 'value2', KEY3: 'value3' })
    })

    it('should skip comments and blank lines', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        '# comment\n\nKEY=val\n  # another comment\n'
      )
      expect(readWorkerEnv()).toEqual({ KEY: 'val' })
    })

    it('should strip surrounding quotes', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'A="double-quoted"\nB=\'single-quoted\'\nC=no-quotes'
      )
      const env = readWorkerEnv()
      expect(env.A).toBe('double-quoted')
      expect(env.B).toBe('single-quoted')
      expect(env.C).toBe('no-quotes')
    })

    it('should handle values with = sign', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('TOKEN=abc=def==')
      expect(readWorkerEnv()).toEqual({ TOKEN: 'abc=def==' })
    })
  })

  // ─── detectProvider ─────────────────────────────────────────

  describe('detectProvider', () => {
    it('should detect bedrock from env overrides', () => {
      expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock')
    })

    it('should detect bedrock from process.env', () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      expect(detectProvider()).toBe('bedrock')
    })

    it('should detect litellm when ANTHROPIC_BASE_URL is set', () => {
      expect(detectProvider({ ANTHROPIC_BASE_URL: 'http://localhost:8000' })).toBe('litellm')
    })

    it('should prefer bedrock over litellm when both set', () => {
      expect(detectProvider({
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_BASE_URL: 'http://localhost:8000',
      })).toBe('bedrock')
    })

    it('should default to anthropic', () => {
      expect(detectProvider({})).toBe('anthropic')
    })
  })

  // ─── detectAuthMethod ───────────────────────────────────────

  describe('detectAuthMethod', () => {
    it('should detect api-keys (bearer token)', () => {
      expect(detectAuthMethod({ AWS_BEARER_TOKEN_BEDROCK: 'tok123' })).toBe('api-keys')
    })

    it('should detect access-keys', () => {
      expect(detectAuthMethod({ AWS_ACCESS_KEY_ID: 'AKIA...' })).toBe('access-keys')
    })

    it('should detect profile', () => {
      expect(detectAuthMethod({ AWS_PROFILE: 'my-profile' })).toBe('profile')
    })

    it('should default to iam-role', () => {
      expect(detectAuthMethod({})).toBe('iam-role')
    })

    it('should prefer bearer token over access-keys', () => {
      expect(detectAuthMethod({
        AWS_BEARER_TOKEN_BEDROCK: 'tok',
        AWS_ACCESS_KEY_ID: 'AKIA',
      })).toBe('api-keys')
    })

    it('should prefer access-keys over profile', () => {
      expect(detectAuthMethod({
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_PROFILE: 'prof',
      })).toBe('access-keys')
    })

    it('should read from process.env as fallback', () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'from-env'
      expect(detectAuthMethod({})).toBe('api-keys')
    })
  })

  // ─── detectModel ────────────────────────────────────────────

  describe('detectModel', () => {
    it('should prefer ANTHROPIC_SMALL_FAST_MODEL', () => {
      expect(detectModel({
        ANTHROPIC_SMALL_FAST_MODEL: 'fast-model',
        ANTHROPIC_MODEL: 'regular-model',
      })).toBe('fast-model')
    })

    it('should fall back to ANTHROPIC_MODEL', () => {
      expect(detectModel({ ANTHROPIC_MODEL: 'claude-3' })).toBe('claude-3')
    })

    it('should fall back to CLAUDE_MODEL', () => {
      expect(detectModel({ CLAUDE_MODEL: 'claude-x' })).toBe('claude-x')
    })

    it('should fall back to MODEL_ID', () => {
      expect(detectModel({ MODEL_ID: 'us.anthropic.claude' })).toBe('us.anthropic.claude')
    })

    it('should return empty string when no model set', () => {
      expect(detectModel({})).toBe('')
    })
  })

  // ─── detectRegion ───────────────────────────────────────────

  describe('detectRegion', () => {
    it('should prefer AWS_REGION', () => {
      expect(detectRegion({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' }))
        .toBe('eu-west-1')
    })

    it('should fall back to AWS_DEFAULT_REGION', () => {
      expect(detectRegion({ AWS_DEFAULT_REGION: 'us-west-2' })).toBe('us-west-2')
    })

    it('should default to us-east-1', () => {
      expect(detectRegion({})).toBe('us-east-1')
    })
  })

  // ─── infer() — Bedrock Bearer Token ─────────────────────────

  describe('infer — Bedrock bearer token', () => {
    const bedrockEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'test-bearer-token',
      AWS_REGION: 'us-east-1',
      ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
    }

    it('should call Bedrock via raw HTTP with bearer token', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        Object.entries(bedrockEnv).map(([k, v]) => `${k}=${v}`).join('\n')
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'Hello!' }] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(true)
      expect(result.provider).toBe('bedrock')
      expect(result.authMethod).toBe('api-keys')
      expect(result.response).toBe('Hello!')

      // Verify bearer token was used
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('bedrock-runtime.us-east-1.amazonaws.com'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-bearer-token',
          }),
        })
      )
    })

    it('should handle 403 from bearer token', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        Object.entries(bedrockEnv).map(([k, v]) => `${k}=${v}`).join('\n')
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(false)
      expect(result.authMethod).toBe('api-keys')
      expect(result.error).toBe('Forbidden')
      expect(result.hint).toContain('invalid or expired')
    })

    it('should handle non-403 error from bearer token', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        Object.entries(bedrockEnv).map(([k, v]) => `${k}=${v}`).join('\n')
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'Internal error' }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(false)
      expect(result.hint).toContain('AWS_BEARER_TOKEN_BEDROCK')
    })

    it('should include system prompt in bearer token request', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        Object.entries(bedrockEnv).map(([k, v]) => `${k}=${v}`).join('\n')
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'OK' }] }),
      } as Response)

      await infer({ prompt: 'Hi', system: 'You are helpful' })

      const callBody = JSON.parse(
        (vi.mocked(global.fetch).mock.calls[0][1] as any).body
      )
      expect(callBody.system).toBe('You are helpful')
    })
  })

  // ─── infer() — Bedrock SigV4 (IAM role) ────────────────────

  describe('infer — Bedrock SigV4', () => {
    it('should use BedrockRuntimeClient when no bearer token', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1'
      )

      const mockSend = vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: 'OK' }] } },
      })
      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({ send: mockSend } as any))

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(true)
      expect(result.provider).toBe('bedrock')
      expect(result.authMethod).toBe('iam-role')
      expect(mockSend).toHaveBeenCalled()
      // fetch should NOT have been called (SigV4 uses SDK, not fetch)
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should detect access-keys auth method', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=model\nAWS_ACCESS_KEY_ID=AKIA123'
      )

      const mockSend = vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: 'OK' }] } },
      })
      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({ send: mockSend } as any))

      const result = await infer({ prompt: 'Hi' })
      expect(result.authMethod).toBe('access-keys')
    })

    it('should handle SDK errors gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nANTHROPIC_MODEL=model'
      )

      const mockSend = vi.fn().mockRejectedValue(new Error('AccessDeniedException'))
      vi.mocked(BedrockRuntimeClient).mockImplementation(() => ({ send: mockSend } as any))

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('AccessDenied')
    })
  })

  // ─── infer() — Anthropic Direct ─────────────────────────────

  describe('infer — Anthropic direct', () => {
    it('should call Anthropic API with x-api-key', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=claude-3-opus-20240229'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'Hello' }] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(true)
      expect(result.provider).toBe('anthropic')
      expect(result.response).toBe('Hello')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-test',
            'anthropic-version': '2023-06-01',
          }),
        })
      )
    })

    it('should fail when no API key set', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('ANTHROPIC_MODEL=claude-3')

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('API key')
    })

    it('should handle API errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=bad-key\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid API key' } }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid API key')
    })
  })

  // ─── infer() — LiteLLM ─────────────────────────────────────

  describe('infer — LiteLLM', () => {
    it('should call LiteLLM proxy with correct headers', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_BASE_URL=http://localhost:8000\nANTHROPIC_MODEL=claude-3\nANTHROPIC_API_KEY=proxy-key'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'Proxied' }] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })

      expect(result.success).toBe(true)
      expect(result.provider).toBe('litellm')
      expect(result.response).toBe('Proxied')

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'proxy-key',
          }),
        })
      )
    })

    it('should work without API key (optional for LiteLLM)', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_BASE_URL=http://localhost:8000\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'OK' }] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(true)
    })

    it('should handle proxy errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_BASE_URL=http://localhost:8000\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: { message: 'Bad Gateway' } }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Bad Gateway')
    })
  })

  // ─── infer() — Edge Cases ───────────────────────────────────

  describe('infer — edge cases', () => {
    it('should fail when no model configured', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('ANTHROPIC_API_KEY=sk-test')

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('model')
    })

    it('should respect maxTokens parameter', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'OK' }] }),
      } as Response)

      await infer({ prompt: 'Hi', maxTokens: 42 })

      const callBody = JSON.parse(
        (vi.mocked(global.fetch).mock.calls[0][1] as any).body
      )
      expect(callBody.max_tokens).toBe(42)
    })

    it('should use envOverrides when provided', async () => {
      // No .env file needed when overrides are given
      vi.mocked(existsSync).mockReturnValue(false)

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'OK' }] }),
      } as Response)

      const result = await infer({
        prompt: 'Hi',
        envOverrides: {
          ANTHROPIC_API_KEY: 'override-key',
          ANTHROPIC_MODEL: 'claude-3',
        },
      })

      expect(result.success).toBe(true)
      expect(result.provider).toBe('anthropic')
    })

    it('should handle network errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })

    it('should handle empty response content', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })
      expect(result.success).toBe(true)
      expect(result.response).toBe('OK') // fallback
    })

    it('should report latencyMs', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=claude-3'
      )

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ text: 'OK' }] }),
      } as Response)

      const result = await infer({ prompt: 'Hi' })
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })
  })
})
