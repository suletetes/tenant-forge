# ElastiCache Redis module (R12, NFR3.1). Single small node (cache.t4g.micro), private subnets,
# reachable only from the app security group.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "app_security_group_id" { type = string }
variable "node_type" {
  type    = string
  default = "cache.t4g.micro"
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis-subnets"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.name}-redis-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Redis from app tasks only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_elasticache_cluster" "this" {
  cluster_id           = "${var.name}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.redis.id]
}

output "endpoint" { value = aws_elasticache_cluster.this.cache_nodes[0].address }
output "port" { value = aws_elasticache_cluster.this.cache_nodes[0].port }
