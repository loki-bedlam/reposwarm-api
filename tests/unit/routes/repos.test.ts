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

// ─────────────────────────────────────────────────────────────────────────────
// Provider auto-detection from env vars (commit 8c12198)
// When no `source` is provided in the request body, the route auto-detects
// the provider from available env var credentials.
// Priority: GITHUB_TOKEN > GITLAB_TOKEN > AZURE_DEVOPS_PAT > BITBUCKET_APP_PASSWORD > codecommit
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/repos/discover — provider auto-detection from env vars', () => {
  beforeEach(() => {
    vi.clearAllMocks() // reset call counts between tests so not.toHaveBeenCalled() works
    mockListRepos.mockResolvedValue([])
    mockPutRepo.mockResolvedValue(undefined)
    // Clear all provider tokens between tests
    delete process.env.GITHUB_TOKEN
    delete process.env.GITLAB_TOKEN
    delete process.env.AZURE_DEVOPS_PAT
    delete process.env.BITBUCKET_APP_PASSWORD
    delete process.env.GITHUB_ORG
  })

  afterEach(() => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GITLAB_TOKEN
    delete process.env.AZURE_DEVOPS_PAT
    delete process.env.BITBUCKET_APP_PASSWORD
  })

  it('auto-detects GitHub when GITHUB_TOKEN is set and no source in body', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test'
    mockDiscoverGitHub.mockResolvedValue([
      { name: 'my-repo', url: 'https://github.com/org/my-repo', source: 'GitHub' }
    ])

    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({}) // no source

    expect(res.status).toBe(200)
    expect(mockDiscoverGitHub).toHaveBeenCalled()
    expect(mockDiscoverGitLab).not.toHaveBeenCalled()
    expect(res.body.data).toMatchObject({ discovered: 1 })
  })

  it('auto-detects GitLab when GITLAB_TOKEN is set and no source in body', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test'
    mockDiscoverGitLab.mockResolvedValue([
      { name: 'gl-repo', url: 'https://gitlab.com/org/gl-repo', source: 'GitLab' }
    ])

    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({}) // no source

    expect(res.status).toBe(200)
    expect(mockDiscoverGitLab).toHaveBeenCalled()
    expect(mockDiscoverGitHub).not.toHaveBeenCalled()
    expect(res.body.data).toMatchObject({ discovered: 1 })
  })

  it('auto-detects Bitbucket when BITBUCKET_APP_PASSWORD is set and no source in body', async () => {
    process.env.BITBUCKET_APP_PASSWORD = 'bb-secret'
    mockDiscoverBitbucket.mockResolvedValue([
      { name: 'bb-repo', url: 'https://bitbucket.org/ws/bb-repo', source: 'Bitbucket' }
    ])

    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({}) // no source

    expect(res.status).toBe(200)
    expect(mockDiscoverBitbucket).toHaveBeenCalled()
    expect(mockDiscoverGitHub).not.toHaveBeenCalled()
  })

  it('defaults to codecommit when no provider env vars are set and no source in body', async () => {
    // No provider env vars set, no source in body → should use codecommit (default)
    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({}) // no source

    expect(res.status).toBe(200)
    // codecommit service was called (mocked to return [])
    expect(mockDiscoverGitHub).not.toHaveBeenCalled()
    expect(mockDiscoverGitLab).not.toHaveBeenCalled()
    expect(mockDiscoverBitbucket).not.toHaveBeenCalled()
  })

  it('uses explicit body source instead of env var auto-detection when source is provided', async () => {
    // Even with GITLAB_TOKEN set, explicit source=github should win
    process.env.GITLAB_TOKEN = 'glpat-test'
    process.env.GITHUB_TOKEN = 'ghp_test'
    mockDiscoverGitHub.mockResolvedValue([])

    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({ source: 'github' }) // explicit source

    expect(res.status).toBe(200)
    expect(mockDiscoverGitHub).toHaveBeenCalled()
    expect(mockDiscoverGitLab).not.toHaveBeenCalled()
  })

  it('GITHUB_TOKEN takes priority over GITLAB_TOKEN when both are set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test'
    process.env.GITLAB_TOKEN = 'glpat-test'
    mockDiscoverGitHub.mockResolvedValue([])

    const res = await request(buildApp())
      .post('/api/repos/discover')
      .send({}) // no source — priority check

    expect(res.status).toBe(200)
    expect(mockDiscoverGitHub).toHaveBeenCalled()
    expect(mockDiscoverGitLab).not.toHaveBeenCalled()
  })
})
