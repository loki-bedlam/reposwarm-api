/**
 * Tests for POST /investigate/single — camelCase + snake_case parameter support.
 *
 * RED-GREEN-REFACTOR cycle:
 *   RED   — Tests written with camelCase params (repoName, repoUrl, chunkSize)
 *            that currently FAIL because the route only accepts snake_case.
 *   GREEN — Route updated to accept both formats via fallback resolution.
 *   REFACTOR — Extract parameter normalization helper if needed.
 *
 * Bug: reposwarm/reposwarm#27 (discussion)
 *   The UI sends camelCase (repoName, repoUrl, chunkSize) but the API
 *   only accepts snake_case (repo_name, repo_url, chunk_size).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// ── env setup must happen BEFORE module imports (vitest hoisting) ─────────────
process.env.LOG_LEVEL = 'silent'
process.env.API_BEARER_TOKEN = 'test-token'

// ── hoist mock references ────────────────────────────────────────────────────
const { mockStartWorkflow, mockGetRepo } = vi.hoisted(() => ({
  mockStartWorkflow: vi.fn(),
  mockGetRepo: vi.fn(),
}))

// ── mock temporal (no real Temporal server) ──────────────────────────────────
vi.mock('../../../src/services/temporal.js', () => ({
  startWorkflow: mockStartWorkflow,
}))

// ── mock dynamodb ────────────────────────────────────────────────────────────
vi.mock('../../../src/services/dynamodb.js', () => ({
  getRepo: mockGetRepo,
  listRepos: vi.fn().mockResolvedValue([]),
  putRepo: vi.fn(),
  updateRepo: vi.fn(),
  deleteRepo: vi.fn(),
  getApiTokenByHash: vi.fn().mockResolvedValue(null),
}))

// ── AWS SDK stubs ────────────────────────────────────────────────────────────
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({ send: vi.fn() }) },
  ScanCommand: vi.fn(),
  GetCommand: vi.fn(),
  PutCommand: vi.fn(),
  DeleteCommand: vi.fn(),
  UpdateCommand: vi.fn(),
}))

vi.mock('@aws-sdk/client-codecommit', () => ({
  CodeCommitClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  ListRepositoriesCommand: vi.fn(),
  BatchGetRepositoriesCommand: vi.fn(),
}))

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn().mockResolvedValue({}) },
  Client: vi.fn().mockImplementation(() => ({
    workflow: {
      start: vi.fn().mockResolvedValue({ workflowId: 'wf-1' }),
      getHandle: vi.fn().mockReturnValue({ terminate: vi.fn() }),
    },
  })),
}))

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn().mockReturnValue({
      verify: vi.fn().mockRejectedValue(new Error('Invalid token')),
    }),
  },
}))

// ── import the router AFTER all mocks ────────────────────────────────────────
import investigateRouter from '../../../src/routes/investigate.js'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal Express app that mounts the investigate router. */
function buildApp() {
  const app = express()
  app.use(express.json())
  // Mount without auth for unit testing the route logic
  app.use(investigateRouter)
  return app
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('POST /investigate/single — camelCase + snake_case parameter support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartWorkflow.mockResolvedValue({ workflowId: 'test-wf-1' })
    mockGetRepo.mockResolvedValue({ name: 'my-repo', url: 'https://github.com/org/my-repo' })
  })

  // ── snake_case (existing behavior) ─────────────────────────────────────────

  describe('snake_case parameters (existing)', () => {
    it('accepts repo_name (snake_case) and returns 202', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({ repo_name: 'my-repo' })

      expect(res.status).toBe(202)
      expect(res.body.data).toHaveProperty('workflowId')
      expect(res.body.data.status).toBe('started')
    })

    it('accepts repo_name + repo_url + chunk_size (all snake_case)', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({
          repo_name: 'my-repo',
          repo_url: 'https://github.com/org/my-repo',
          chunk_size: 20,
        })

      expect(res.status).toBe(202)
      // Verify the workflow was started with the correct params
      expect(mockStartWorkflow).toHaveBeenCalledWith(
        'InvestigateSingleRepoWorkflow',
        expect.any(String),
        [
          expect.objectContaining({
            repo_name: 'my-repo',
            repo_url: 'https://github.com/org/my-repo',
            chunk_size: 20,
          }),
        ]
      )
    })
  })

  // ── camelCase (bug fix — these should FAIL before the fix) ─────────────────

  describe('camelCase parameters (bug fix)', () => {
    it('accepts repoName (camelCase) and returns 202', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({ repoName: 'my-repo' })

      // Before fix: returns 400 with "repo_name is required"
      // After fix: returns 202
      expect(res.status).toBe(202)
      expect(res.body.data).toHaveProperty('workflowId')
      expect(res.body.data.status).toBe('started')
    })

    it('accepts repoName + repoUrl + chunkSize (all camelCase)', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({
          repoName: 'my-repo',
          repoUrl: 'https://github.com/org/my-repo',
          chunkSize: 20,
        })

      expect(res.status).toBe(202)
      // Verify the workflow was started with the correct params (snake_case to Temporal)
      expect(mockStartWorkflow).toHaveBeenCalledWith(
        'InvestigateSingleRepoWorkflow',
        expect.any(String),
        [
          expect.objectContaining({
            repo_name: 'my-repo',
            repo_url: 'https://github.com/org/my-repo',
            chunk_size: 20,
          }),
        ]
      )
    })

    it('prefers snake_case when both formats are provided', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({
          repo_name: 'snake-repo',
          repoName: 'camel-repo',
          repo_url: 'https://github.com/org/snake-repo',
          repoUrl: 'https://github.com/org/camel-repo',
        })

      expect(res.status).toBe(202)
      // snake_case should take priority
      expect(mockStartWorkflow).toHaveBeenCalledWith(
        'InvestigateSingleRepoWorkflow',
        expect.any(String),
        [
          expect.objectContaining({
            repo_name: 'snake-repo',
            repo_url: 'https://github.com/org/snake-repo',
          }),
        ]
      )
    })
  })

  // ── missing repo name ──────────────────────────────────────────────────────

  describe('missing repo name', () => {
    it('returns 400 when neither repo_name nor repoName is provided', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({ repo_url: 'https://github.com/org/my-repo' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('repo_name is required')
    })

    it('returns 400 when body is empty', async () => {
      const res = await request(buildApp())
        .post('/investigate/single')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('repo_name is required')
    })
  })

  // ── workflow dedup ─────────────────────────────────────────────────────────

  describe('workflow dedup', () => {
    it('returns 409 when workflow already exists', async () => {
      mockStartWorkflow.mockRejectedValue(
        Object.assign(new Error('workflow already exists'), { code: 6 })
      )

      const res = await request(buildApp())
        .post('/investigate/single')
        .send({ repo_name: 'my-repo' })

      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/already running/)
    })
  })
})

// ── POST /investigate/daily — camelCase parameter support ────────────────────

describe('POST /investigate/daily — camelCase + snake_case parameter support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartWorkflow.mockResolvedValue({ workflowId: 'test-wf-daily' })
  })

  it('accepts snake_case parameters (existing behavior)', async () => {
    const res = await request(buildApp())
      .post('/investigate/daily')
      .send({ sleep_hours: 12, chunk_size: 5, force: true })

    expect(res.status).toBe(202)
    expect(res.body.data.status).toBe('started')
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      'InvestigateReposWorkflow',
      expect.any(String),
      [
        expect.objectContaining({
          sleep_hours: 12,
          chunk_size: 5,
          force: true,
        }),
      ]
    )
  })

  it('accepts camelCase parameters (sleepHours, chunkSize)', async () => {
    const res = await request(buildApp())
      .post('/investigate/daily')
      .send({ sleepHours: 12, chunkSize: 5, force: true })

    expect(res.status).toBe(202)
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      'InvestigateReposWorkflow',
      expect.any(String),
      [
        expect.objectContaining({
          sleep_hours: 12,
          chunk_size: 5,
          force: true,
        }),
      ]
    )
  })

  it('accepts camelCase maxTokens', async () => {
    const res = await request(buildApp())
      .post('/investigate/daily')
      .send({ maxTokens: 4096, model: 'us.anthropic.claude-sonnet-4-6' })

    expect(res.status).toBe(202)
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      'InvestigateReposWorkflow',
      expect.any(String),
      [
        expect.objectContaining({
          claude_model: 'us.anthropic.claude-sonnet-4-6',
          max_tokens: 4096,
        }),
      ]
    )
  })
})
