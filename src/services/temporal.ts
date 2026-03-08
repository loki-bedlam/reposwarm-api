import { Connection, Client } from '@temporalio/client'
import { config } from '../config.js'
import { logger } from '../middleware/logger.js'
import { WorkflowExecution, WorkflowHistory } from '../types/index.js'
import { formatStartedAgo, isWorkflowStale } from '../utils/helpers.js'

let grpcClient: Client | null = null

async function getGrpcClient(): Promise<Client> {
  if (!grpcClient) {
    const connection = await Connection.connect({ address: config.temporalServerUrl })
    grpcClient = new Client({ connection, namespace: config.temporalNamespace })
  }
  return grpcClient
}

function normalizeStatus(raw: string): string {
  return raw
    .replace('WORKFLOW_EXECUTION_STATUS_', '')
    .toLowerCase()
    .replace(/^\w/, c => c.toUpperCase())
}

// === HTTP reads (Temporal UI proxy) ===

async function temporalGet(path: string): Promise<any> {
  const url = `${config.temporalHttpUrl}/api/v1/namespaces/${config.temporalNamespace}${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Temporal HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function listWorkflows(limit = 50): Promise<{ executions: WorkflowExecution[] }> {
  const data = await temporalGet(`/workflows?maximumPageSize=${limit}`)
  const executions = (data.executions || []).map((exec: any) => {
    const startTime = exec.startTime || ''
    const status = normalizeStatus(exec.status || 'Running')
    return {
      workflowId: exec.execution?.workflowId || '',
      runId: exec.execution?.runId || '',
      type: exec.type?.name || '',
      status,
      startTime,
      closeTime: exec.closeTime,
      taskQueueName: exec.taskQueue || config.temporalTaskQueue,
      stale: isWorkflowStale(status, startTime),
      startedAgo: formatStartedAgo(startTime)
    }
  })
  return { executions }
}

export async function getWorkflow(workflowId: string, runId?: string): Promise<WorkflowExecution | null> {
  try {
    const path = runId ? `/workflows/${workflowId}?runId=${runId}` : `/workflows/${workflowId}`
    const data = await temporalGet(path)
    const info = data.workflowExecutionInfo || data
    const startTime = info.startTime || ''
    const status = normalizeStatus(info.status || 'Running')
    return {
      workflowId: info.execution?.workflowId || workflowId,
      runId: info.execution?.runId || runId || '',
      type: info.type?.name || '',
      status,
      startTime,
      closeTime: info.closeTime,
      taskQueueName: info.taskQueue || config.temporalTaskQueue,
      input: data.input,
      result: data.result,
      memo: data.memo,
      stale: isWorkflowStale(status, startTime),
      startedAgo: formatStartedAgo(startTime)
    }
  } catch (e) {
    logger.error({ err: e, workflowId }, 'Failed to get workflow')
    return null
  }
}

export async function getWorkflowHistory(workflowId: string, runId?: string): Promise<WorkflowHistory> {
  const params = runId ? `?runId=${runId}` : ''
  const data = await temporalGet(`/workflows/${workflowId}/history${params}`)
  return {
    events: (data.history?.events || []).map((e: any) => ({
      eventId: e.eventId || '',
      eventTime: e.eventTime || '',
      eventType: e.eventType || '',
      details: e.attributes || e.details
    }))
  }
}

// === gRPC writes ===

export async function startWorkflow(workflowType: string, workflowId: string, args: any[]): Promise<string> {
  const client = await getGrpcClient()
  const handle = await client.workflow.start(workflowType, {
    taskQueue: config.temporalTaskQueue,
    workflowId,
    args,
  })
  return handle.workflowId
}

export async function terminateWorkflow(workflowId: string, reason?: string): Promise<void> {
  const client = await getGrpcClient()
  const handle = client.workflow.getHandle(workflowId)
  await handle.terminate(reason || 'Terminated via API')
}

export async function healthCheck(): Promise<boolean> {
  try {
    await temporalGet('/workflows?maximumPageSize=1')
    return true
  } catch (e) {
    logger.error({ err: e }, 'Temporal health check failed')
    return false
  }
}

export function resetClient() { grpcClient = null }
