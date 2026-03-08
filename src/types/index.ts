export interface Repository {
  name: string
  url: string
  source: string
  enabled: boolean
  status: string
  lastAnalyzed?: string
  lastCommit?: string
  hasDocs?: boolean
}

export interface WorkflowExecution {
  workflowId: string
  runId: string
  type: string
  status: string
  startTime: string
  closeTime?: string
  duration?: number
  taskQueueName?: string
  input?: any
  result?: any
  memo?: any
  stale: boolean
  startedAgo: string
  failure?: {
    message: string
    source?: string
    stackTrace?: string
    cause?: any
  }
}

export interface WorkflowHistory {
  events: WorkflowEvent[]
}

export interface WorkflowEvent {
  eventId: string
  eventTime: string
  eventType: string
  details?: any
}

export interface Prompt {
  name: string
  displayName?: string
  description: string
  content: string
  order: number
  enabled: boolean
  type: string
  context?: ContextDep[]
  version: number
  createdAt: string
  updatedAt: string
  createdBy?: string
}

export interface ContextDep {
  type: string
  val: string
}

export interface PromptVersion {
  name: string
  version: number
  content: string
  message?: string
  createdBy: string
  createdAt: string
}

export interface PromptType {
  type: string
  promptDir: string
  description: string
  additionalPrompts: { name: string; file: string; description: string }[]
  detectionPatterns?: any
}

export interface WikiRepoSummary {
  name: string
  sectionCount: number
  lastUpdated: string
  highlights: string[]
}

export interface WikiSection {
  id: string
  label: string
  stepName: string
  createdAt: string
  hasContent: boolean
}

export interface RepoSwarmConfig {
  defaultModel: string
  chunkSize: number
  sleepDuration: number
  parallelLimit: number
  tokenLimit: number
  scheduleExpression: string
}

export interface HealthResponse {
  status: string
  version: string
  temporal: { connected: boolean }
  dynamodb: { connected: boolean }
}

export interface AuthUser {
  sub: string
  email?: string
  type: 'cognito' | 'm2m'
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export interface WorkerInfo {
  name: string
  identity: string
  status: 'healthy' | 'degraded' | 'failed' | 'stopped' | 'unknown'
  taskQueue: string
  currentTask?: string
  lastActivity?: string
  envStatus: string
  envErrors: string[]
  pid?: number
  uptime?: string
  host?: string
  model?: string
}

export interface ServiceInfo {
  name: string
  pid: number
  status: 'running' | 'stopped'
  uptime?: string
  port?: number
  manager?: string
}

export interface EnvEntry {
  key: string
  value: string
  source: string
  set: boolean
}
