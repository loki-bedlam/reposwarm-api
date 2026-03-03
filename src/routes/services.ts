import { Router, Request, Response } from 'express'
import { ServiceInfo } from '../types/index.js'
import { logger } from '../middleware/logger.js'
import { execSync, spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

const router = Router()
const INSTALL_DIR = process.env.REPOSWARM_INSTALL_DIR || join(os.homedir(), 'reposwarm')

const KNOWN_SERVICES = ['api', 'worker', 'temporal', 'ui']
const DEFAULT_PORTS: Record<string, number> = {
  api: parseInt(process.env.PORT || '3000'),
  worker: 0,
  temporal: parseInt(process.env.TEMPORAL_GRPC_PORT || '7233'),
  ui: parseInt(process.env.UI_PORT || '3001'),
}

function findPID(service: string): number {
  const patterns: Record<string, string[]> = {
    api: ['node.*reposwarm-api', 'node.*dist/index'],
    worker: ['python.*src.worker', 'python.*worker'],
    temporal: ['temporal-server'],
    ui: ['next-server', 'node.*reposwarm-ui'],
  }
  for (const pattern of (patterns[service] || [])) {
    try {
      const out = execSync(`pgrep -f '${pattern}'`, { encoding: 'utf-8', timeout: 3000 }).trim()
      const pid = parseInt(out.split('\n')[0])
      if (pid > 0) return pid
    } catch { /* not found */ }
  }
  return 0
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function detectManager(service: string): string {
  try {
    const out = execSync(`systemctl is-active reposwarm-${service} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim()
    if (out === 'active') return 'systemd'
  } catch { /* */ }
  try {
    const out = execSync(`docker ps --filter name=${service} --format '{{.Names}}' 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim()
    if (out) return 'docker'
  } catch { /* */ }
  if (findPID(service) > 0) return 'process'
  return ''
}

function gatherServices(): ServiceInfo[] {
  return KNOWN_SERVICES.map(name => {
    const pid = findPID(name)
    return {
      name,
      pid,
      status: (pid > 0 && isRunning(pid)) ? 'running' as const : 'stopped' as const,
      port: DEFAULT_PORTS[name],
      manager: detectManager(name),
    }
  })
}

function readEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {}
  if (!existsSync(path)) return vars
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1).trim()
  }
  return vars
}

// GET /services
router.get('/services', async (_req: Request, res: Response) => {
  res.json({ data: gatherServices() })
})

// GET /services/:name/logs
router.get('/services/:name/logs', async (req: Request, res: Response) => {
  const name = req.params.name as string
  if (!KNOWN_SERVICES.includes(name)) {
    return res.status(400).json({ error: `Unknown service: ${name}` })
  }

  const lines = parseInt(req.query.lines as string) || 50
  const candidates = [
    join(INSTALL_DIR, 'logs', `${name}.log`),
    join(INSTALL_DIR, name, `${name}.log`),
  ]

  for (const logFile of candidates) {
    if (!existsSync(logFile)) continue
    const content = readFileSync(logFile, 'utf-8')
    const allLines = content.split('\n').filter(l => l.trim())
    const tail = allLines.slice(-lines)
    return res.json({ data: { service: name, logFile, lines: tail, total: allLines.length } })
  }

  res.json({ data: { service: name, logFile: null, lines: [], total: 0 } })
})

// POST /services/:name/restart
router.post('/services/:name/restart', async (req: Request, res: Response) => {
  const name = req.params.name as string
  if (!KNOWN_SERVICES.includes(name)) {
    return res.status(400).json({ error: `Unknown service: ${name}` })
  }

  // Stop
  const pid = findPID(name)
  if (pid > 0) {
    try { process.kill(pid, 'SIGTERM') } catch { /* */ }
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (isRunning(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* */ }
  }

  await new Promise(resolve => setTimeout(resolve, 500))

  // Start
  let newPid = 0
  const svcDir = join(INSTALL_DIR, name)
  const envVars = readEnvFile(join(svcDir, '.env'))
  const env = { ...process.env, ...envVars }

  try {
    switch (name) {
      case 'api': {
        const child = spawn('node', ['dist/index.js'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref()
        newPid = child.pid || 0
        break
      }
      case 'worker': {
        const child = spawn('python3', ['-m', 'src.worker'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref()
        newPid = child.pid || 0
        break
      }
      case 'temporal': {
        const composeFile = join(INSTALL_DIR, 'temporal', 'docker-compose.yml')
        if (existsSync(composeFile)) {
          execSync(`docker compose -f ${composeFile} up -d`, { timeout: 30000 })
        }
        break
      }
      case 'ui': {
        const child = spawn('npm', ['start'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref()
        newPid = child.pid || 0
        break
      }
    }
    logger.info({ service: name, pid: newPid }, 'Service restarted')
    res.json({ data: { service: name, status: 'restarted', pid: newPid } })
  } catch (err: any) {
    res.status(500).json({ error: `Failed to restart ${name}: ${err.message}` })
  }
})

// POST /services/:name/upgrade — git pull + npm install + npm build + restart
router.post('/services/:name/upgrade', async (req: Request, res: Response) => {
  const name = req.params.name as string
  if (!['api', 'ui', 'worker'].includes(name)) {
    return res.status(400).json({ error: `Cannot upgrade service: ${name}` })
  }

  const svcDir = join(INSTALL_DIR, name)
  if (!existsSync(svcDir)) {
    return res.status(404).json({ error: `Service directory not found: ${svcDir}` })
  }

  try {
    // Get current version before upgrade
    let oldVersion = ''
    const pkgPath = join(svcDir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        oldVersion = pkg.version || ''
      } catch { /* */ }
    }

    // Git pull
    logger.info({ service: name }, 'Upgrading: git pull')
    const pullOutput = execSync('git pull', { cwd: svcDir, encoding: 'utf-8', timeout: 30000 }).trim()
    const alreadyUpToDate = pullOutput.includes('Already up to date') || pullOutput.includes('Already up-to-date')

    if (alreadyUpToDate && !req.body?.force) {
      return res.json({
        data: {
          oldVersion,
          newVersion: oldVersion,
          updated: false,
          restarted: false,
          message: 'Already up to date'
        }
      })
    }

    // npm install (if package.json exists)
    if (existsSync(pkgPath)) {
      logger.info({ service: name }, 'Upgrading: npm install')
      execSync('npm install --production', { cwd: svcDir, timeout: 120000, stdio: 'pipe' })
    }

    // Build (if build script exists)
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (pkg.scripts?.build) {
          logger.info({ service: name }, 'Upgrading: npm run build')
          execSync('npm run build', { cwd: svcDir, timeout: 120000, stdio: 'pipe' })
        }
      } catch { /* */ }
    }

    // For python worker: pip install
    const reqFile = join(svcDir, 'requirements.txt')
    if (existsSync(reqFile)) {
      logger.info({ service: name }, 'Upgrading: pip install')
      execSync('pip3 install -r requirements.txt', { cwd: svcDir, timeout: 120000, stdio: 'pipe' })
    }

    // Get new version
    let newVersion = ''
    if (existsSync(pkgPath)) {
      try {
        // Re-read after pull
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        newVersion = pkg.version || ''
      } catch { /* */ }
    }

    // Restart the service (skip for self if name is api — we'll handle that separately)
    let restarted = false
    if (name !== 'api') {
      const pid = findPID(name)
      if (pid > 0) {
        try { process.kill(pid, 'SIGTERM') } catch { /* */ }
        await new Promise(resolve => setTimeout(resolve, 2000))
        if (isRunning(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* */ }
      }
      await new Promise(resolve => setTimeout(resolve, 500))

      const envVars = readEnvFile(join(svcDir, '.env'))
      const env = { ...process.env, ...envVars }

      switch (name) {
        case 'worker': {
          const child = spawn('python3', ['-m', 'src.worker'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
          child.unref()
          restarted = true
          break
        }
        case 'ui': {
          const child = spawn('npm', ['start'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
          child.unref()
          restarted = true
          break
        }
      }
    } else {
      // For API: respond first, then restart self after a delay
      restarted = true
      setTimeout(() => {
        logger.info('API self-restart after upgrade')
        process.exit(0) // Let process manager (systemd/pm2) restart us
      }, 1000)
    }

    logger.info({ service: name, oldVersion, newVersion }, 'Upgrade complete')
    res.json({
      data: {
        oldVersion,
        newVersion,
        updated: true,
        restarted,
        message: `Upgraded ${name}${oldVersion && newVersion ? ` v${oldVersion} → v${newVersion}` : ''}`
      }
    })
  } catch (err: any) {
    logger.error({ service: name, error: err.message }, 'Upgrade failed')
    res.status(500).json({ error: `Upgrade failed: ${err.message}` })
  }
})

// POST /services/:name/stop
router.post('/services/:name/stop', async (req: Request, res: Response) => {
  const name = req.params.name as string
  const pid = findPID(name)
  if (pid > 0) {
    try { process.kill(pid, 'SIGTERM') } catch { /* */ }
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (isRunning(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* */ }
    return res.json({ data: { service: name, status: 'stopped', pid } })
  }

  if (name === 'temporal') {
    const composeFile = join(INSTALL_DIR, 'temporal', 'docker-compose.yml')
    if (existsSync(composeFile)) {
      try {
        execSync(`docker compose -f ${composeFile} down`, { timeout: 30000 })
        return res.json({ data: { service: name, status: 'stopped' } })
      } catch { /* */ }
    }
  }

  res.json({ data: { service: name, status: 'not_found' } })
})

// POST /services/:name/start
router.post('/services/:name/start', async (req: Request, res: Response) => {
  const name = req.params.name as string
  // Same as restart but without the stop step
  const svcDir = join(INSTALL_DIR, name)
  const envVars = readEnvFile(join(svcDir, '.env'))
  const env = { ...process.env, ...envVars }
  let newPid = 0

  try {
    switch (name) {
      case 'api': {
        const child = spawn('node', ['dist/index.js'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref(); newPid = child.pid || 0; break
      }
      case 'worker': {
        const child = spawn('python3', ['-m', 'src.worker'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref(); newPid = child.pid || 0; break
      }
      case 'temporal': {
        const composeFile = join(INSTALL_DIR, 'temporal', 'docker-compose.yml')
        if (existsSync(composeFile)) execSync(`docker compose -f ${composeFile} up -d`, { timeout: 30000 })
        break
      }
      case 'ui': {
        const child = spawn('npm', ['start'], { cwd: svcDir, env, detached: true, stdio: 'ignore' })
        child.unref(); newPid = child.pid || 0; break
      }
    }
    res.json({ data: { service: name, status: 'started', pid: newPid } })
  } catch (err: any) {
    res.status(500).json({ error: `Failed to start ${name}: ${err.message}` })
  }
})

export default router
