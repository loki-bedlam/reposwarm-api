import { Router } from 'express'
import { ECSClient, ListServicesCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import { config } from '../config.js'

const router = Router()

const SERVICE_ORDER: Record<string, number> = {
  worker: 0,
  api: 1,
  ui: 2,
  temporal: 3,
  'temporal-ui': 4,
}

const SERVICE_DISPLAY: Record<string, string> = {
  worker: 'Worker',
  api: 'API',
  ui: 'UI',
  temporal: 'Temporal',
  'temporal-ui': 'Temporal UI',
}

function displayName(serviceName: string): string {
  for (const [suffix, name] of Object.entries(SERVICE_DISPLAY)) {
    if (serviceName.endsWith(`-${suffix}`)) return name
  }
  return serviceName
}

function sortKey(serviceName: string): number {
  for (const [suffix, order] of Object.entries(SERVICE_ORDER)) {
    if (serviceName.endsWith(`-${suffix}`)) return order
  }
  return 99
}

/**
 * GET /infrastructure
 *
 * Returns ECS service status for the RepoSwarm cluster.
 * Requires ECS_CLUSTER_NAME env var on the API task.
 */
router.get('/infrastructure', async (_req, res) => {
  const cluster = config.ecsClusterName

  if (!cluster) {
    return res.json({ data: { services: [], source: 'unavailable' } })
  }

  try {
    const client = new ECSClient({ region: config.region })

    // List services
    const listResult = await client.send(new ListServicesCommand({ cluster }))
    const serviceArns = listResult.serviceArns || []

    if (serviceArns.length === 0) {
      return res.json({ data: { services: [], source: 'ecs' } })
    }

    // Describe all services in one call
    const descResult = await client.send(
      new DescribeServicesCommand({ cluster, services: serviceArns })
    )

    // Collect task definition ARNs to describe (deduplicated)
    const tdArns = new Set<string>()
    for (const svc of descResult.services || []) {
      if (svc.taskDefinition) tdArns.add(svc.taskDefinition)
    }

    // Describe all task definitions in parallel
    const tdMap = new Map<string, { cpu: number; memory: number; arch: string }>()
    await Promise.all(
      Array.from(tdArns).map(async (arn) => {
        try {
          const tdResult = await client.send(
            new DescribeTaskDefinitionCommand({ taskDefinition: arn })
          )
          const td = tdResult.taskDefinition
          tdMap.set(arn, {
            cpu: parseInt(td?.cpu || '0', 10),
            memory: parseInt(td?.memory || '0', 10),
            arch: td?.runtimePlatform?.cpuArchitecture || 'X86_64',
          })
        } catch {
          // task def describe can fail — fill with defaults
          tdMap.set(arn, { cpu: 0, memory: 0, arch: 'unknown' })
        }
      })
    )

    const services = (descResult.services || []).map((svc) => {
      const name = svc.serviceName || 'unknown'
      const deployment = svc.deployments?.[0]
      const td = svc.taskDefinition ? tdMap.get(svc.taskDefinition) : undefined

      return {
        name,
        displayName: displayName(name),
        desired: svc.desiredCount || 0,
        running: svc.runningCount || 0,
        pending: svc.pendingCount || 0,
        status: svc.status || 'UNKNOWN',
        cpu: td?.cpu || 0,
        memory: td?.memory || 0,
        arch: td?.arch || 'unknown',
        lastDeployment: deployment?.updatedAt?.toISOString(),
        deploymentStatus: deployment?.rolloutState,
      }
    })

    services.sort((a, b) => sortKey(a.name) - sortKey(b.name))

    return res.json({ data: { services, source: 'ecs' } })
  } catch (error) {
    return res.status(500).json({
      data: { services: [], source: 'error', error: String(error) },
    })
  }
})

export default router
