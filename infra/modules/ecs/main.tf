# ECS Fargate module (R17.1). Cluster + service + task definition. Stateless (NFR2.3).
# Secrets are injected from Secrets Manager at runtime (R17.4) — never baked into the image.

variable "name" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "target_group_arn" { type = string }
variable "image" { type = string }
variable "container_port" {
  type    = number
  default = 3000
}
variable "execution_role_arn" { type = string }
variable "task_role_arn" { type = string }
variable "secret_arn" { type = string }
variable "app_security_group_id" { type = string }
variable "desired_count" {
  type    = number
  default = 1
}
variable "cpu" {
  type    = string
  default = "256"
}
variable "memory" {
  type    = string
  default = "512"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 14
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"
}

# Inject each secret JSON key as an env var via valueFrom (secret_arn:KEY::).
locals {
  secret_keys = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "JWT_SIGNING_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name         = var.name
      image        = var.image
      essential    = true
      portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port) },
      ]
      secrets = [for k in local.secret_keys : { name = k, valueFrom = "${var.secret_arn}:${k}::" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name            = "${var.name}-svc"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.name
    container_port   = var.container_port
  }

  # CI updates the task definition image; ignore drift on desired_count from autoscaling later.
  lifecycle { ignore_changes = [desired_count] }
}

output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.this.name }
output "task_definition_arn" { value = aws_ecs_task_definition.this.arn }
