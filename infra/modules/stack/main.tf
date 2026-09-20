# Shared application stack (composition module). Each environment root (dev/staging/prod) is a
# thin wrapper that sets its own backend + provider and passes env-specific vars here. This keeps
# the full topology defined ONCE (R17 reproducibility, Task 19 promotion).

variable "region" { type = string }
variable "env" { type = string }
variable "app_image" { type = string }
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
variable "certificate_arn" {
  type    = string
  default = ""
}
variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "enable_admin_spa" {
  type    = bool
  default = false # opt-in per env (CloudFront distribution)
}

locals {
  name = "tenantforge-${var.env}"
}

module "vpc" {
  source = "../vpc"
  name   = local.name
  region = var.region
}

resource "aws_security_group" "app" {
  name_prefix = "${local.name}-app-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description = "From ALB"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle { create_before_destroy = true }
}

module "alb" {
  source            = "../alb"
  name              = local.name
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = var.certificate_arn
}

module "rds" {
  source                = "../rds"
  name                  = local.name
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  app_security_group_id = aws_security_group.app.id
  master_password       = var.db_master_password
  instance_class        = var.rds_instance_class
}

locals {
  db_host = module.rds.endpoint
  db_port = module.rds.port
  db_name = module.rds.db_name
  app_url = "postgresql://tenantforge_app:${var.app_db_password}@${local.db_host}:${local.db_port}/${local.db_name}"
  mig_url = "postgresql://tenantforge_migrator:${var.db_master_password}@${local.db_host}:${local.db_port}/${local.db_name}"
}

module "secrets" {
  source                 = "../secrets"
  name                   = local.name
  database_url           = local.app_url
  migration_database_url = local.mig_url
  jwt_signing_secret     = var.jwt_signing_secret
}

module "iam" {
  source     = "../iam"
  name       = local.name
  secret_arn = module.secrets.secret_arn
}

resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

module "ecs" {
  source                = "../ecs"
  name                  = local.name
  region                = var.region
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_security_group_id = module.alb.alb_security_group_id
  target_group_arn      = module.alb.target_group_arn
  image                 = var.app_image
  execution_role_arn    = module.iam.execution_role_arn
  task_role_arn         = module.iam.task_role_arn
  secret_arn            = module.secrets.secret_arn
  app_security_group_id = aws_security_group.app.id
}

module "elasticache" {
  source                = "../elasticache"
  name                  = local.name
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  app_security_group_id = aws_security_group.app.id
}

module "waf" {
  source  = "../waf"
  name    = local.name
  alb_arn = module.alb.alb_arn
}

module "cloudwatch" {
  source                  = "../cloudwatch"
  name                    = local.name
  alb_arn_suffix          = module.alb.alb_arn_suffix
  target_group_arn_suffix = module.alb.target_group_arn_suffix
  alarm_email             = var.alarm_email
}

# Admin SPA hosting (Task 22): S3 + CloudFront. Optional per env.
module "static_site" {
  count  = var.enable_admin_spa ? 1 : 0
  source = "../static-site"
  name   = local.name
}

output "alb_dns_name" { value = module.alb.alb_dns_name }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "ecs_cluster" { value = module.ecs.cluster_name }
output "ecs_service" { value = module.ecs.service_name }
output "rds_instance_id" { value = module.rds.instance_id }
output "redis_endpoint" { value = module.elasticache.endpoint }
output "alarms_topic_arn" { value = module.cloudwatch.sns_topic_arn }
output "admin_spa_domain" {
  value = var.enable_admin_spa ? module.static_site[0].cloudfront_domain : null
}
output "migration_secret_arn" { value = module.secrets.secret_arn }
