import { Router } from 'express'
import * as dynamodb from '../services/dynamodb.js'

const router = Router()

router.get('/wiki', async (_req, res) => {
  const repos = await dynamodb.listWikiRepos()
  res.json({ data: { repos } })
})

router.get('/wiki/:repo', async (req, res) => {
  const sections = await dynamodb.listWikiSections(req.params.repo)
  if (sections.length === 0) { res.status(404).json({ error: 'No wiki found for this repo' }); return }
  res.json({ data: { repo: req.params.repo, sections, hasDocs: sections.length > 0 } })
})

router.get('/wiki/:repo/:section', async (req, res) => {
  const content = await dynamodb.getWikiSection(req.params.repo, req.params.section)
  if (!content) { res.status(404).json({ error: 'Section not found' }); return }
  res.json({ data: { repo: req.params.repo, section: req.params.section, content } })
})

export default router
