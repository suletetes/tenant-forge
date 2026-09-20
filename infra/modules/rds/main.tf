# RDS PostgreSQL module (R17.1, NFR3.1). Smallest viable instance (db.t4g.micro), private only.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "app_security_group_id" { type = string }
variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "db_name" {
  type    = string
  default = "tenantforge"
}
variable "master_username" {
  type    = string
  default = "tenantforge_migrator"
}
variable "master_password" {
  type      = string
  sensitive = true
}
variable "allocated_storage" {
  type    = number
  default = 20
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db-subnets"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Postgres from app tasks only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_db_instance" "this" {
  identifier             = "${var.name}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.instance_class
  allocated_storage      = var.allocated_storage
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.master_username
  password               = var.master_password
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  multi_az               = false
  publicly_accessible    = false
  skip_final_snapshot    = true # dev/demo; enable snapshots for prod
  deletion_protection    = false
  apply_immediately      = true
}

output "endpoint" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }
output "db_name" { value = aws_db_instance.this.db_name }
output "security_group_id" { value = aws_security_group.db.id }
output "instance_id" { value = aws_db_instance.this.identifier }
