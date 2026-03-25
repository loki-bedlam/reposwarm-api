import { Router } from 'express'
import * as temporal from '../services/temporal.js'
import * as dynamodb from '../services/dynamodb.js'

const router = Router()

router.post('/investigate/single', async (req, res) => {
  console.log(`[INVESTIGATE] POST /investigate/single called at ${Date.now()} from ${req.ip} body=${JSON.stringify(req.body)}`)
  // Accept both snake_case (CLI) and camelCase (UI) parameter formats
  const { repo_name, repoName, repo_url, repoUrl, model, chunk_size, chunkSize, force } = req.body
  const resolvedRepoName = repo_name || repoName
  const resolvedRepoUrl = repo_url || repoUrl
  const resolvedChunkSize = chunk_size || chunkSize

  if (!resolvedRepoName) { res.status(400).json({ error: 'repo_name is required' }); return }

  let url = resolvedRepoUrl
  if (!url) {
    // If repo_name looks like a URL, use it directly
    if (resolvedRepoName.startsWith('http://') || resolvedRepoName.startsWith('https://') || resolvedRepoName.startsWith('git@')) {
      url = resolvedRepoName
    } else {
      const repo = await dynamodb.getRepo(resolvedRepoName)
      if (repo) url = repo.url
    }
  }

  // Use a deterministic workflow ID to prevent duplicates
  // Temporal will reject if a workflow with this ID is already running
  const ts = Math.floor(Date.now() / 1000) // 1-second granularity prevents rapid double-submits
  const workflowId = `investigate-single-${resolvedRepoName}-${ts}`
  try {
    await temporal.startWorkflow('InvestigateSingleRepoWorkflow', workflowId, [{
      repo_name: resolvedRepoName,
      repo_url: url || '',
      model: model || 'us.anthropic.claude-sonnet-4-6',
      chunk_size: resolvedChunkSize || 10,
      force: Boolean(force),
    }])
    res.status(202).json({ data: { workflowId, status: 'started' } })
  } catch (err: any) {
    if (err?.message?.includes('already exists') || err?.code === 6) {
      res.status(409).json({ error: 'workflow already running for this repo', workflowId })
    } else {
      throw err
    }
  }
})

router.post('/investigate/daily', async (req, res) => {
  // Accept both snake_case (CLI) and camelCase (UI) parameter formats
  const {
    sleep_hours, sleepHours,
    chunk_size, chunkSize,
    model,
    max_tokens, maxTokens,
    force = false,
  } = req.body || {}

  const resolvedSleepHours = sleep_hours ?? sleepHours ?? 24
  const resolvedChunkSize = chunk_size ?? chunkSize ?? 10
  const resolvedMaxTokens = max_tokens ?? maxTokens

  const workflowId = `investigate-daily-${Date.now()}`

  // InvestigateReposRequest Pydantic model fields:
  //   force, claude_model, max_tokens, sleep_hours, chunk_size, iteration_count
  const workflowInput: Record<string, unknown> = {
    force: Boolean(force),
    sleep_hours: Number(resolvedSleepHours),
    chunk_size: Number(resolvedChunkSize),
    iteration_count: 0,
  }
  if (model) workflowInput.claude_model = model
  if (resolvedMaxTokens) workflowInput.max_tokens = Number(resolvedMaxTokens)

  await temporal.startWorkflow('InvestigateReposWorkflow', workflowId, [workflowInput])
  res.status(202).json({
    data: {
      workflowId,
      status: 'started',
      sleepHours: resolvedSleepHours,
      chunkSize: resolvedChunkSize,
      force,
    }
  })
})

export default router
