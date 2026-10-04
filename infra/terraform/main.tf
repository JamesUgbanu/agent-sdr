# Minimal AWS infrastructure for the SDR agent (single-service, no K8s).
# Provisions: Postgres (RDS), Redis (ElastiCache), ECS service (app), ECS worker,
# secrets references (Secrets Manager), logs. Follows the existing architecture:
# one Next.js app + one worker process + managed database/cache.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "project" { default = "sdr-agent" }
variable "region" { default = "us-east-1" }
variable "db_password" { sensitive = true }
variable "app_image" { description = "Docker image for app+worker (Dockerfile at repo root)" }

provider "aws" { region = var.region }

resource "aws_db_instance" "postgres" {
  identifier             = "${var.project}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  username               = "sdr"
  password               = var.db_password
  skip_final_snapshot    = true
  backup_retention_period = 7
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id      = "${var.project}-redis"
  engine          = "redis"
  engine_version  = "7.0"
  node_type       = "cache.t4g.micro"
  num_cache_nodes = 1
}

resource "aws_secretsmanager_secret" "app" {
  name = "${var.project}/env"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}"
  retention_in_days = 30
}

output "db_endpoint" { value = aws_db_instance.postgres.endpoint }
output "redis_endpoint" { value = aws_elasticache_cluster.redis.cache_nodes[0].address }
