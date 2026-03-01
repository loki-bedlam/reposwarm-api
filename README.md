# RepoSwarm API Server

Standalone REST API server for RepoSwarm — the backend that the UI, CLI, and agents all talk to.

## Stack
- **Runtime:** Node.js 24+, TypeScript, Express 5
- **Auth:** Cognito JWT (UI) + Bearer token (CLI/M2M)
- **Storage:** DynamoDB (`reposwarm-cache`)
- **Workflows:** Temporal (gRPC + HTTP)
- **Deploy:** ECS Fargate (ARM64)

## Quick Start

```bash
npm install
npm run dev     # Development with hot reload
npm test        # Run tests
npm run build   # Compile TypeScript
npm start       # Production
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET/POST | `/repos` | Yes | List/create repos |
| GET/PUT/DELETE | `/repos/:name` | Yes | CRUD single repo |
| POST | `/repos/discover` | Yes | Auto-discover CodeCommit |
| GET | `/workflows` | Yes | List workflows |
| GET | `/workflows/:id` | Yes | Workflow detail |
| GET | `/workflows/:id/history` | Yes | Event history |
| POST | `/workflows/:id/terminate` | Yes | Terminate workflow |
| POST | `/investigate/single` | Yes | Start investigation |
| POST | `/investigate/daily` | Yes | Start daily batch |
| GET | `/wiki` | Yes | List documented repos |
| GET | `/wiki/:repo` | Yes | List sections |
| GET | `/wiki/:repo/:section` | Yes | Get content |
| GET/POST | `/prompts` | Yes | List/create prompts |
| GET/PUT/DELETE | `/prompts/:name` | Yes | CRUD prompt |
| PUT | `/prompts/:name/order` | Yes | Reorder |
| PUT | `/prompts/:name/toggle` | Yes | Enable/disable |
| PUT | `/prompts/:name/context` | Yes | Context deps |
| GET | `/prompts/:name/versions` | Yes | Version history |
| POST | `/prompts/:name/rollback` | Yes | Rollback version |
| GET/PUT | `/config` | Yes | Configuration |

## Auth

Send `Authorization: Bearer <token>` with either:
- A valid Cognito JWT (from `us-east-1_XgaUUc0TG`)
- The API bearer token (from `API_BEARER_TOKEN` env var)
# Auto-trigger test 19:30
