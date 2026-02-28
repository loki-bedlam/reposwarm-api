import { Router } from 'express'
import * as dynamodb from '../services/dynamodb.js'

const router = Router()

// Static routes MUST come before parameterized routes
router.get('/prompts/types', async (_req, res) => {
  const types = await dynamodb.listPromptTypes()
  res.json({ data: types })
})

router.get('/prompts/types/:type', async (req, res) => {
  const type = await dynamodb.getPromptType(req.params.type)
  if (!type) { res.status(404).json({ error: 'Type not found' }); return }
  res.json({ data: type })
})

router.post('/prompts/export', async (_req, res) => {
  const prompts = await dynamodb.listPrompts()
  const types = await dynamodb.listPromptTypes()
  const versions: Record<string, any[]> = {}
  for (const p of prompts) {
    versions[p.name] = await dynamodb.listPromptVersions(p.name)
  }
  res.json({ data: { prompts, types, versions } })
})

router.post('/prompts/import', async (req, res) => {
  const { prompts } = req.body
  let imported = 0
  if (prompts) {
    for (const p of prompts) { await dynamodb.putPrompt(p); imported++ }
  }
  res.json({ data: { imported } })
})

router.get('/prompts', async (req, res) => {
  const type = req.query.type as string | undefined
  const enabledParam = req.query.enabled as string | undefined
  let prompts = await dynamodb.listPrompts(type)
  if (enabledParam !== undefined) {
    const wantEnabled = enabledParam === 'true'
    prompts = prompts.filter(p => p.enabled === wantEnabled)
  }
  res.json({ data: prompts })
})

router.post('/prompts', async (req, res) => {
  const { name, content, description, order, type, context } = req.body
  if (!name || !content) { res.status(400).json({ error: 'name and content are required' }); return }
  const existing = await dynamodb.getPrompt(name)
  if (existing) { res.status(409).json({ error: 'Prompt already exists' }); return }
  const prompt = { name, content, description: description || '', order: order ?? 999, type: type || 'shared', context, version: 1, enabled: true, createdBy: req.user?.type === 'm2m' ? 'cli' : 'api' }
  await dynamodb.putPrompt(prompt)
  await dynamodb.putPromptVersion(name, 1, content, 'Initial version', prompt.createdBy)
  res.status(201).json({ data: prompt })
})

router.get('/prompts/:name', async (req, res) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  res.json({ data: prompt })
})

router.put('/prompts/:name', async (req, res) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  const { content, message, description, type, order, enabled, context } = req.body
  // Build update — content triggers a new version, other fields are metadata updates
  const updates: Record<string, any> = {}
  if (content !== undefined) updates.content = content
  if (description !== undefined) updates.description = description
  if (type !== undefined) updates.type = type
  if (order !== undefined) updates.order = order
  if (enabled !== undefined) updates.enabled = enabled
  if (context !== undefined) updates.context = context
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'No update fields provided' }); return }
  const newVersion = content !== undefined ? prompt.version + 1 : prompt.version
  const createdBy = req.user?.type === 'm2m' ? 'cli' : 'api'
  await dynamodb.putPrompt({ ...prompt, ...updates, version: newVersion })
  if (content !== undefined) {
    await dynamodb.putPromptVersion(req.params.name, newVersion, content, message, createdBy)
  }
  res.json({ data: { ...prompt, ...updates, version: newVersion } })
})

router.delete('/prompts/:name', async (req, res) => {
  await dynamodb.deletePrompt(req.params.name)
  res.json({ data: { deleted: true } })
})

router.put('/prompts/:name/order', async (req, res) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  const { position } = req.body
  if (typeof position !== 'number' || position < 1) { res.status(400).json({ error: 'Valid position required' }); return }
  await dynamodb.putPrompt({ ...prompt, order: position })
  res.json({ data: { ...prompt, order: position } })
})

router.put('/prompts/:name/toggle', async (req, res) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  const { enabled } = req.body
  await dynamodb.putPrompt({ ...prompt, enabled: !!enabled })
  res.json({ data: { ...prompt, enabled: !!enabled } })
})

router.put('/prompts/:name/context', async (req, res) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  const { context } = req.body
  await dynamodb.putPrompt({ ...prompt, context })
  res.json({ data: { ...prompt, context } })
})

router.get('/prompts/:name/versions', async (req, res) => {
  const versions = await dynamodb.listPromptVersions(req.params.name)
  res.json({ data: versions })
})

router.get('/prompts/:name/versions/:version', async (req, res) => {
  const version = parseInt(req.params.version)
  const pv = await dynamodb.getPromptVersion(req.params.name, version)
  if (!pv) { res.status(404).json({ error: 'Version not found' }); return }
  res.json({ data: pv })
})

// Support both POST and PUT for rollback
const rollbackHandler = async (req: any, res: any) => {
  const prompt = await dynamodb.getPrompt(req.params.name)
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return }
  const { toVersion } = req.body
  const oldVersion = await dynamodb.getPromptVersion(req.params.name, toVersion)
  if (!oldVersion) { res.status(404).json({ error: 'Target version not found' }); return }
  const newVersion = prompt.version + 1
  const createdBy = req.user?.type === 'm2m' ? 'cli' : 'api'
  await dynamodb.putPrompt({ ...prompt, content: oldVersion.content, version: newVersion })
  await dynamodb.putPromptVersion(req.params.name, newVersion, oldVersion.content, `Rollback to v${toVersion}`, createdBy)
  res.json({ data: { ...prompt, content: oldVersion.content, version: newVersion } })
}
router.post('/prompts/:name/rollback', rollbackHandler)
router.put('/prompts/:name/rollback', rollbackHandler)

export default router
