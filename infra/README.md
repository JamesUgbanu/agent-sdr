# Infrastructure

Deployment and cloud infrastructure configuration for Agent SDR.

## What belongs here

Infrastructure that is **separate from the local Docker runtime** — cloud providers,
managed services, secrets, networking, and production deployment configuration.

## What lives at the repository root (not here)

| File | Why it stays at root |
|---|---|
| `Dockerfile` | Core image build — part of the primary `docker compose up` workflow |
| `docker-compose.yml` | Local development stack (app + worker + postgres + redis) |
| `docker/entrypoint.sh` | Container startup logic (migrations, seeding, secrets) |

The local development workflow is:

```bash
cp .env.example .env
docker compose up --build
```

This requires only Docker — no cloud account, no Terraform.

## Current infrastructure

### `terraform/` — AWS (minimal, single-service)

Provisions the managed services for a production-style deployment:

- **RDS PostgreSQL 16** — primary database
- **ElastiCache Redis 7** — job queue
- **Secrets Manager** — application secrets reference
- **CloudWatch Logs** — log retention

Prerequisites: AWS account, Terraform ≥ 1.6, AWS CLI configured.

```bash
cd infra/terraform
terraform init
terraform plan
terraform apply
```

The Terraform configuration provisions infrastructure only. Application secrets are
stored in Secrets Manager and injected at deploy time — never committed to the repository.

## Local development vs production

| Concern | Local (Docker) | Production (Terraform) |
|---|---|---|
| Database | `postgres` container, persistent volume | RDS PostgreSQL |
| Queue | `redis` container | ElastiCache Redis |
| Secrets | `.env` file (gitignored) | Secrets Manager |
| App + worker | `docker compose up` | ECS (or any container host) |
| Cost | Free | ~$50–100/month depending on sizing |

## Future infrastructure

Planned but not yet implemented:

- ECS/Fargate task definitions for app + worker
- Application Load Balancer + HTTPS
- CI/CD pipeline for automated deploys
- Monitoring/alerting (CloudWatch alarms, SNS)
- Staging environment parity
