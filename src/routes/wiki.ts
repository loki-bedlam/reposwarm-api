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

// Raw markdown endpoint — returns all sections concatenated as text/markdown
// Useful for giving the URL to an AI agent or downloading
router.get('/wiki/:repo/raw', async (req, res) => {
  const repo = req.params.repo
  const sections = await dynamodb.listWikiSections(repo)
  if (sections.length === 0) { res.status(404).type('text').send(`No wiki found for repo: ${repo}`); return }

  // Preferred section order
  const ORDER = [
    'hl_overview', 'module_deep_dive', 'core_entities', 'data_mapping',
    'DBs', 'APIs', 'events', 'dependencies', 'service_dependencies',
    'authentication', 'authorization', 'security_check', 'prompt_security_check',
    'deployment', 'monitoring', 'ml_services', 'feature_flags'
  ]
  const sorted = [...sections].sort((a, b) => {
    const ai = ORDER.indexOf(a.id); const bi = ORDER.indexOf(b.id)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  const parts: string[] = [`# ${repo} — Architecture Documentation\n`]
  for (const section of sorted) {
    const content = await dynamodb.getWikiSection(repo, section.id)
    if (content) {
      parts.push(`\n---\n\n## ${section.label}\n\n${content}`)
    }
  }

  res.type('text/markdown; charset=utf-8').send(parts.join('\n'))
})

router.get('/wiki/:repo/:section', async (req, res) => {
  const content = await dynamodb.getWikiSection(req.params.repo, req.params.section)
  if (!content) { res.status(404).json({ error: 'Section not found' }); return }
  res.json({ data: { repo: req.params.repo, section: req.params.section, content } })
})

export default router
