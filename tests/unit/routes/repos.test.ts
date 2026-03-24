/**
 * Tests for POST /repos/discover — org/group/workspace auto-detection from env vars.
 *
 * RED-GREEN-REFACTOR cycle:
 *   RED   — Tests were first written with deliberately wrong expectations (e.g. asserting
 *            that org was NOT passed when GITHUB_ORG is set) to confirm they failed.
 *   GREEN — Expectations corrected to match the real behaviour introduced in commit 8c12198.
 *   REFACTOR — Tests cleaned up and grouped for clarity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// ── env setup must happen BEFORE module imports (vitest hoisting) ─────────────
process.env.LOG_LEVEL = 'silent'
process.env.API_BEARER_TOKEN = 'test-token'

// ── hoist mock references so they are available in vi.mock() factories ────────
const { mockDiscoverGitHub, mockDiscoverGitLab, mockDiscoverBitbucket, mockListRepos, mockPutRepo } =
  vi.hoisted(() => ({
    mockDiscoverGitHub:    vi.fn(),
    mockDiscoverGitLab:    vi.fn(),
    mockDiscoverBitbucket: vi.fn(),
    mockListRepos:         vi.fn(),
    mockPutRepo:           vi.fn()
  }))

// ── mock discovery services (no real API calls) ───────────────────────────────
vi.mock('../../../src/services/github.js', () => ({
  discoverRepos: mockDiscoverGitHub
}))

vi.mock('../../../src/services/gitlab.js', () => ({
  discoverRepos: mockDiscoverGitLab
}))

vi.mock('../../../src/services/bitbucket.js', () => ({
  discoverRepos: mockDiscoverBitbucket
}))

vi.mock('../../../src/services/azure.js', () => ({
  discoverRepos: vi.fn().mockResolvedValue([])
}))

vi.mock('../../../src/services/codecommit.js', () => ({
  discoverRepos: vi.fn().mockResolvedValue([])
}))

vi.mock('../../../src/services/dynamodb.js', () => ({
  listRepos: mockListRepos,
  putRepo:   mockPutRepo,
  getRepo:   vi.fn(),
  updateRepo: vi.fn(),
  deleteRepo: vi.fn()
}))

// ── AWS SDK stubs (required by module load chain) ─────────────────────────────
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({}))
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({ send: vi.fn() }) },
  ScanCommand:   vi.fn(),
  GetCommand:    vi.fn(),
  PutCommand:    vi.fn(),
  DeleteCommand: vi.fn(),
  UpdateCommand: vi.fn()
}))

vi.mock('@aws-sdk/client-codecommit', () => ({
  CodeCommitClient:           vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  ListRepositoriesCommand:    vi.fn(),
  BatchGetRepositoriesCommand: vi.fn()
}))

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn().mockResolvedValue({}) },
  Client: vi.fn().mockImplementation(() => ({
    workflow: {
      start:     vi.fn().mockResolvedValue({ workflowId: 'wf-1' }),
      getHandle: vi.fn().mockReturnValue({ terminate: vi.fn() })
    }
  }))
}))

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn().mockReturnValue({
      verify: vi.fn().mockRejectedValue(new Error('Invalid token'))
    })
  }
}))

// ── import the router AFTER all mocks are registered ─────────────────────────
import reposRouter from '../../../src/routes/repos.js'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal Express app that mounts the repos router. */
function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', reposRouter)
  return app
}

/** Typical empty-DB response so the route can complete successfully. */
function stubEmptyDb() {
  mockListRepos.mockResolvedValue([])
  mockPutRepo.mockResolvedValue(undefined)
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('POST /api/repos/discover — org/group/workspace auto-detection', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    vi.clearAllMocks()
    // Snapshot env so each test gets a clean slate
    savedEnv = { ...process.env }
    // Ensure env vars start unset
    delete process.env.GITHUB_ORG
    delete process.env.GITLAB_GROUP
    delete process.env.BITBUCKET_WORKSPACE
    // Ensure provider tokens are present so auto-detection picks GitHub by default
    process.env.GITHUB_TOKEN = 'ghp_test'
    stubEmptyDb()
  })

  afterEach(() => {
    // Restore original env
    process.env = savedEnv
  })

  // ── GitHub ──────────────────────────────────────────────────────────────────

  describe('GitHub', () => {
    it('passes GITHUB_ORG env var as org when no org in request body', async () => {
      process.env.GITHUB_ORG = 'env-org'
      mockDiscoverGitHub.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'github' })

      expect(res.status).toBe(200)
      // GREEN: env var org IS forwarded to the discovery service
      expect(mockDiscoverGitHub).toHaveBeenCalledWith('env-org')
    })

    it('uses body org instead of GITHUB_ORG env var when both are present', async () => {
      process.env.GITHUB_ORG = 'env-org'
      mockDiscoverGitHub.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'github', org: 'body-org' })

      expect(res.status).toBe(200)
      // GREEN: explicit body org takes priority over env var
      expect(mockDiscoverGitHub).toHaveBeenCalledWith('body-org')
      expect(mockDiscoverGitHub).not.toHaveBeenCalledWith('env-org')
    })

    it('passes undefined org when neither GITHUB_ORG env var nor body org is set', async () => {
      mockDiscoverGitHub.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'github' })

      expect(res.status).toBe(200)
      // GREEN: no org → undefined passed (discover user repos, no org filter)
      expect(mockDiscoverGitHub).toHaveBeenCalledWith(undefined)
    })
  })

  // ── GitLab ──────────────────────────────────────────────────────────────────

  describe('GitLab', () => {
    beforeEach(() => {
      delete process.env.GITHUB_TOKEN
      process.env.GITLAB_TOKEN = 'gl-test'
    })

    it('passes GITLAB_GROUP env var as group when no group in request body', async () => {
      process.env.GITLAB_GROUP = 'env-group'
      mockDiscoverGitLab.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'gitlab' })

      expect(res.status).toBe(200)
      // GREEN: env var group IS forwarded
      expect(mockDiscoverGitLab).toHaveBeenCalledWith('env-group')
    })

    it('uses body group instead of GITLAB_GROUP env var when both are present', async () => {
      process.env.GITLAB_GROUP = 'env-group'
      mockDiscoverGitLab.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'gitlab', group: 'body-group' })

      expect(res.status).toBe(200)
      // GREEN: explicit body group takes priority
      expect(mockDiscoverGitLab).toHaveBeenCalledWith('body-group')
      expect(mockDiscoverGitLab).not.toHaveBeenCalledWith('env-group')
    })

    it('passes undefined group when neither env var nor body group is set', async () => {
      mockDiscoverGitLab.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'gitlab' })

      expect(res.status).toBe(200)
      expect(mockDiscoverGitLab).toHaveBeenCalledWith(undefined)
    })
  })

  // ── Bitbucket ────────────────────────────────────────────────────────────────

  describe('Bitbucket', () => {
    beforeEach(() => {
      delete process.env.GITHUB_TOKEN
      process.env.BITBUCKET_APP_PASSWORD = 'bb-test'
    })

    it('passes BITBUCKET_WORKSPACE env var as workspace when no workspace in request body', async () => {
      process.env.BITBUCKET_WORKSPACE = 'env-ws'
      mockDiscoverBitbucket.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'bitbucket' })

      expect(res.status).toBe(200)
      // GREEN: env var workspace IS forwarded
      expect(mockDiscoverBitbucket).toHaveBeenCalledWith('env-ws')
    })

    it('uses body workspace instead of BITBUCKET_WORKSPACE env var when both are present', async () => {
      process.env.BITBUCKET_WORKSPACE = 'env-ws'
      mockDiscoverBitbucket.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'bitbucket', workspace: 'body-ws' })

      expect(res.status).toBe(200)
      // GREEN: explicit body workspace takes priority
      expect(mockDiscoverBitbucket).toHaveBeenCalledWith('body-ws')
      expect(mockDiscoverBitbucket).not.toHaveBeenCalledWith('env-ws')
    })

    it('passes undefined workspace when neither env var nor body workspace is set', async () => {
      mockDiscoverBitbucket.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'bitbucket' })

      expect(res.status).toBe(200)
      expect(mockDiscoverBitbucket).toHaveBeenCalledWith(undefined)
    })
  })

  // ── discovery count + dedup ──────────────────────────────────────────────────

  describe('Discovery response', () => {
    it('returns correct counts when repos are newly discovered', async () => {
      process.env.GITHUB_ORG = 'my-org'
      mockDiscoverGitHub.mockResolvedValue([
        { name: 'repo-a', url: 'https://github.com/my-org/repo-a', source: 'GitHub' },
        { name: 'repo-b', url: 'https://github.com/my-org/repo-b', source: 'GitHub' }
      ])
      mockListRepos.mockResolvedValue([])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'github' })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ discovered: 2, added: 2, skipped: 0 })
    })

    it('skips repos that already exist in the database', async () => {
      process.env.GITHUB_ORG = 'my-org'
      mockDiscoverGitHub.mockResolvedValue([
        { name: 'repo-a', url: 'https://github.com/my-org/repo-a', source: 'GitHub' },
        { name: 'repo-b', url: 'https://github.com/my-org/repo-b', source: 'GitHub' }
      ])
      // repo-a already exists
      mockListRepos.mockResolvedValue([{ name: 'repo-a' }])

      const res = await request(buildApp())
        .post('/api/repos/discover')
        .send({ source: 'github' })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ discovered: 2, added: 1, skipped: 1 })
    })
  })
})
