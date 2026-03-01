# RepoSwarm Infrastructure — Deployment Guide & Known Gotchas

> **Last updated:** 2026-03-01 by Loki  
> **Audience:** Developers, agents, and operators deploying or debugging RepoSwarm

---

## Architecture Overview

```
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
│ RepoSwarm   │──▶│ RepoSwarm    │──▶│ Temporal Server   │
│ UI (Next.js)│   │ API (Express)│   │ (gRPC :7233)      │
│ CloudFront  │   │ ECS Fargate  │   │ ECS Fargate       │
└─────────────┘   └──────────────┘   └──────────────────┘
                         │                    │
                         ▼                    ▼
                  ┌──────────────┐   ┌──────────────────┐
                  │ DynamoDB     │   │ RepoSwarm Worker  │
                  │ reposwarm-   │   │ (Python/Temporal) │
                  │ cache        │   │ ECS Fargate       │
                  └──────────────┘   └──────────────────┘
                                            │
                                     ┌──────┴──────┐
                                     ▼             ▼
                              ┌───────────┐ ┌───────────┐
                              │ CodeCommit│ │ Bedrock   │
                              │ Repos     │ │ Claude    │
                              └───────────┘ └───────────┘
```

## VPC & Networking

- **VPC:** `reposwarm-vpc` (`10.195.0.0/16`, `vpc-0c3d0bfb5b32d83e4`)
- **Private subnets:** `subnet-02788a20bb60d5488`, `subnet-077b95002ba533d3c`
- **NLB:** `reposwarm-temporal-nlb-11f3aaedbbea9cf1` (ports 7233 gRPC, 8233 HTTP UI)

### VPC Endpoints

| Endpoint | Purpose |
|----------|---------|
| `ecr.api`, `ecr.dkr` | Pull container images |
| `logs` | CloudWatch Logs |
| `secretsmanager` | API keys |
| `bedrock-runtime` | Claude API calls from worker |
| `s3` | General S3 access |
| `ssm`, `ssmmessages` | ECS Exec (added 2026-03-01) |
| `guardduty-data` | GuardDuty |

## ECS Services (cluster: `reposwarm-cluster`)

| Service | Task Def | Image | Purpose |
|---------|----------|-------|---------|
| `temporal-server` | `temporal-server:3` | `temporal-server:latest` | Workflow orchestration |
| `temporal-ui-v2` | `temporal-ui:3` | `temporal-ui:latest` | Temporal dashboard |
| `reposwarm-worker` | `reposwarm-worker:5` | `reposwarm-worker:latest` | Python workflow worker |
| `reposwarm-api` | `reposwarm-api` | `reposwarm-api:latest` | REST API server |
| `reposwarm-ui` | `reposwarm-ui:2` | `reposwarm-ui:latest` | Next.js frontend |

## Pipelines

| Pipeline | Source | Deploys |
|----------|--------|---------|
| `reposwarm-api-pipeline` | GitHub (`loki-bedlam/reposwarm-api`) | reposwarm-api ECS service |
| `reposwarm-ui-pipeline` | CodeCommit (`reposwarm-ui`) | reposwarm-ui ECS service |
| `reposwarm-cli-pipeline` | GitHub (`loki-bedlam/reposwarm-cli`) | Go binary (GitHub Release) |
| ⚠️ **No pipeline for worker** | Manual ECR push | reposwarm-worker ECS service |

---

## 🚨 Critical Deployment Gotchas

### 1. `InvestigateDailyWorkflow` Does NOT Exist

**Symptom:** Worker logs flood with:
```
temporalio.exceptions.ApplicationError: NotFoundError: Workflow class
InvestigateDailyWorkflow is not registered on this worker, available
workflows: InvestigateReposWorkflow, InvestigateSingleRepoWorkflow
```
Temporal server logs show `Critical attempts processing workflow task` with increasing attempt counts.

**Root cause:** The API route `POST /investigate/daily` was starting a workflow type called `InvestigateDailyWorkflow` which was never implemented in the Python worker.

**Fix (2026-03-01):** Changed to start `InvestigateReposWorkflow` with proper `InvestigateReposRequest` params. The workflow has a built-in `continue_as_new` loop — after each investigation cycle, it sleeps for `sleep_hours` then repeats automatically.

**Correct daily trigger payload:**
```json
{
  "sleep_hours": 24,
  "chunk_size": 10,
  "force": false
}
```

**The worker only registers these workflow types:**
- `InvestigateReposWorkflow` — multi-repo investigation (daily runs)
- `InvestigateSingleRepoWorkflow` — single repo investigation

**If you add a new workflow type:** You MUST register it in `investigate_worker.py` in the `Worker(workflows=[...])` list AND import it at the top. Temporal will silently accept the start request from any client but the worker will fail on every activation attempt.

### 2. `CODECOMMIT_ENABLED=true` Is Required

**Symptom:** Worker logs show:
```
WARNING - Failed to update repository list: Update repos script failed
with exit code 2. Error: can't open file '/app/scripts/update_repos.py':
[Errno 2] No such file or directory
```

**Root cause:** The `update_repos_list` activity has two code paths:
- `CODECOMMIT_ENABLED=true` → uses boto3 to list CodeCommit repos directly (works)
- Default (GitHub mode) → shells out to `scripts/update_repos.py` (not included in Docker image)

**Fix:** Set `CODECOMMIT_ENABLED=true` in the worker task definition environment variables. This was added in task def revision 5 (2026-03-01).

**Impact if missing:** Non-blocking — the workflow logs a warning and continues with the existing `repos.json`. But no new repos will be auto-discovered.

### 3. Temporal Workflow Replay — Old Failures Persist

**Lesson:** Temporal replays workflow history on worker restart. If a workflow failed due to a code bug, fixing the code and restarting the worker does NOT fix already-running workflows — Temporal replays the old activity results.

**Fix:** TERMINATE stuck workflows and start fresh. Use ECS Exec or the Temporal UI to terminate them:
```bash
aws ecs execute-command --cluster reposwarm-cluster \
  --task <WORKER_TASK_ID> --container reposwarm-worker --interactive \
  --command "python3 -c '
import asyncio
from temporalio.client import Client
async def f():
    c = await Client.connect(\"reposwarm-temporal-nlb-11f3aaedbbea9cf1.elb.us-east-1.amazonaws.com:7233\")
    h = c.get_workflow_handle(\"<WORKFLOW_ID>\")
    await h.terminate(reason=\"reason\")
asyncio.run(f())
'"
```

### 4. ECS Exec Requires SSM Infrastructure

**Symptom:** `TargetNotConnectedException` or `execute command failed` when running `aws ecs execute-command`.

**Requirements (all must be present):**
1. `enableExecuteCommand: true` on the ECS service
2. `AmazonSSMManagedInstanceCore` IAM policy on the **task role** (not execution role)
3. `ssm` and `ssmmessages` VPC endpoints in the VPC
4. Security group on the VPC endpoints must allow **inbound TCP 443** from the task's security group
5. Task must be **redeployed after** all of the above are in place (SSM agent starts at task launch)

**Security groups that need 443 access to the SSM VPC endpoint SG (`sg-0dd00ec4e114d62f9`):**
- Worker SG: `sg-0ed329e13383b6b5c`
- API SG: `sg-0c4e15c8a53194935`
- UI SG: `sg-0dd00ec4e114d62f9` (self-referencing)

### 5. Temporal UI CSRF Is Strict

**Symptom:** GET requests to Temporal UI HTTP API work, POST requests fail with `missing csrf token`.

**Root cause:** Temporal UI Server uses gorilla/csrf middleware. The `Temporal-Csrf-Token: nocheck` header does NOT bypass it. `TEMPORAL_CSRF_COOKIE_INSECURE=true` only affects cookie Secure flag.

**Fix:** Use the `@temporalio/client` gRPC SDK (port 7233) for mutations (start/terminate workflows). Use the HTTP API (port 8233) only for reads (list/get/history).

### 6. NLB Port Mapping

```
Port 7233 → Temporal Server gRPC (workflow operations)
Port 8233 → Temporal UI HTTP (read-only REST API, NOT the native Temporal HTTP API)
```

Do not confuse port 8233 with Temporal Server's native HTTP API — it's the Temporal UI proxy.

### 7. No Worker Pipeline — Manual Builds

The `reposwarm-worker` image is built and pushed manually. There is no CodePipeline for it.

**To update the worker image:**
```bash
# Log in to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 194908539076.dkr.ecr.us-east-1.amazonaws.com

# Build and push (from the worker source directory)
docker build -t reposwarm-worker .
docker tag reposwarm-worker:latest 194908539076.dkr.ecr.us-east-1.amazonaws.com/reposwarm-worker:latest
docker push 194908539076.dkr.ecr.us-east-1.amazonaws.com/reposwarm-worker:latest

# Force ECS to pick up the new image
aws ecs update-service --cluster reposwarm-cluster --service reposwarm-worker --force-new-deployment --region us-east-1
```

### 8. Cross-VPC Access

The OpenClaw EC2 instance (`10.0.0.0/16`) **cannot reach** the reposwarm VPC (`10.195.0.0/16`) — there is no VPC peering between them. To debug Temporal or run commands against it, use ECS Exec into a container within the reposwarm VPC.

---

## Environment Variables (Worker)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `TEMPORAL_SERVER_URL` | Yes | `localhost:7233` | NLB gRPC endpoint |
| `TEMPORAL_NAMESPACE` | No | `default` | |
| `TEMPORAL_TASK_QUEUE` | No | `investigate-task-queue` | |
| `CODECOMMIT_ENABLED` | **Yes** | `false` | Must be `true` for auto-discovery |
| `CLAUDE_PROVIDER` | No | `anthropic` | Set to `bedrock` for AWS Bedrock |
| `DYNAMODB_TABLE_NAME` | Yes | — | `reposwarm-cache` |
| `ARCH_HUB_REPO_NAME` | No | — | CodeCommit repo for architecture docs |
| `ARCH_HUB_BASE_URL` | No | — | CodeCommit base URL |
| `GIT_USER_NAME` | No | `Architecture Bot` | Git commit author |
| `GIT_USER_EMAIL` | No | — | Git commit email |

## Environment Variables (API)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `TEMPORAL_SERVER_URL` | Yes | NLB endpoint | gRPC for writes |
| `TEMPORAL_HTTP_URL` | Yes | NLB:8233 | HTTP for reads |
| `API_BEARER_TOKEN` | Yes | — | M2M auth token |
| `COGNITO_USER_POOL_ID` | Yes | — | JWT validation |
| `COGNITO_CLIENT_ID` | Yes | — | JWT audience |

---

## Useful Commands

```bash
# List all running workflows
aws ecs execute-command --cluster reposwarm-cluster \
  --task <WORKER_TASK> --container reposwarm-worker --interactive \
  --command "python3 -c '
import asyncio
from temporalio.client import Client
async def f():
    c = await Client.connect(\"reposwarm-temporal-nlb-11f3aaedbbea9cf1.elb.us-east-1.amazonaws.com:7233\")
    async for wf in c.list_workflows(\"ExecutionStatus=\\\"Running\\\"\"):
        print(f\"{wf.id} type={wf.workflow_type} status={wf.status.name}\")
asyncio.run(f())
'"

# Check worker logs
TASK=$(aws ecs list-tasks --cluster reposwarm-cluster --service-name reposwarm-worker --query 'taskArns[0]' --output text --region us-east-1)
TID=$(echo $TASK | awk -F/ '{print $NF}')
aws logs get-log-events --log-group-name /ecs/reposwarm-worker \
  --log-stream-name "ecs/reposwarm-worker/$TID" --limit 30 \
  --query 'events[*].message' --output json --region us-east-1

# Trigger daily investigation
curl -X POST https://dkhtk1q9b2nii.cloudfront.net/v1/investigate/daily \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_BEARER_TOKEN>" \
  -d '{"sleep_hours": 24, "chunk_size": 10}'
```
