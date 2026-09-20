# dev environment — thin wrapper over the shared stack module (Task 19). Backend + provider are
# per-env; the full topology lives in modules/stack.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
  backend "s3" {
    key = "tenantforge/dev/terraform.tfstate"
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}
variable "app_image" {
  type    = string
  default = "public.ecr.aws/docker/library/busybox:latest"
}
variable "jwt_signing_secret" {
  type      = string
  sensitive = true
}
variable "db_master_password" {
  type      = string
  sensitive = true
}
variable "app_db_password" {
  type      = string
  sensitive = true
}
variable "alarm_email" {
  type    = string
  default = ""
}

module "stack" {
  source             = "../../modules/stack"
  env                = "dev"
  region             = var.region
  app_image          = var.app_image
  jwt_signing_secret = var.jwt_signing_secret
  db_master_password = var.db_master_password
  app_db_password    = var.app_db_password
  alarm_email        = var.alarm_email
  certificate_arn    = "" # dev is HTTP-only
}

output "alb_dns_name" { value = module.stack.alb_dns_name }
output "ecr_repository_url" { value = module.stack.ecr_repository_url }
output "ecs_cluster" { value = module.stack.ecs_cluster }
output "ecs_service" { value = module.stack.ecs_service }
output "rds_instance_id" { value = module.stack.rds_instance_id }
output "redis_endpoint" { value = module.stack.redis_endpoint }
output "alarms_topic_arn" { value = module.stack.alarms_topic_arn }
