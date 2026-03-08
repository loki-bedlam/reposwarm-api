export function extractRepoName(workflowId: string): string {
  const match = workflowId.match(/^investigate-single-(.+)-\d+$/)
  return match ? match[1] : workflowId
}

/**
 * Formats a duration in milliseconds as a human-readable string (e.g., "2h 30m ago", "45m ago")
 */
export function formatStartedAgo(startTimeIso: string): string {
  const startTime = new Date(startTimeIso).getTime()
  const now = Date.now()
  const diffMs = now - startTime
  const minutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  if (hours > 0) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`
  }
  return `${minutes}m ago`
}

/**
 * Determines if a workflow is stale based on status and start time.
 * A workflow is stale if:
 * - status is "Running" AND
 * - it started more than 30 minutes ago
 */
export function isWorkflowStale(status: string, startTimeIso: string): boolean {
  if (status !== 'Running') {
    return false
  }
  const startTime = new Date(startTimeIso).getTime()
  const now = Date.now()
  const diffMs = now - startTime
  const minutes = Math.floor(diffMs / 60000)
  return minutes > 30
}
