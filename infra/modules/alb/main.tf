# ALB module (R17.1). Public ALB → Fargate target group with /health check.
# TLS termination (R19.3) is added in V3 with ACM; HTTP listener here for dev.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "container_port" {
  type    = number
  default = 3000
}
# When set, an HTTPS:443 listener is added and HTTP:80 redirects to it (R19.3).
variable "certificate_arn" {
  type    = string
  default = ""
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
}

resource "aws_lb_target_group" "this" {
  name        = "${var.name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    matcher             = "200"
  }
}

locals {
  tls_enabled = var.certificate_arn != ""
}

# HTTP:80 — forwards to the app when TLS is off (dev); redirects to HTTPS when TLS is on (R19.3).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.tls_enabled ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
  dynamic "default_action" {
    for_each = local.tls_enabled ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.this.arn
    }
  }
}

# HTTPS:443 — only when an ACM certificate is provided.
resource "aws_lb_listener" "https" {
  count             = local.tls_enabled ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

output "alb_arn" { value = aws_lb.this.arn }

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_security_group_id" { value = aws_security_group.alb.id }
output "target_group_arn" { value = aws_lb_target_group.this.arn }
output "alb_arn_suffix" { value = aws_lb.this.arn_suffix }
output "target_group_arn_suffix" { value = aws_lb_target_group.this.arn_suffix }
