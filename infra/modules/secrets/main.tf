# Secrets Manager module (R17.4). Stores DB URLs, JWT signing key, Stripe keys. Never in repo/images.

variable "name" { type = string }
variable "database_url" {
  type      = string
  sensitive = true
}
variable "migration_database_url" {
  type      = string
  sensitive = true
}
variable "jwt_signing_secret" {
  type      = string
  sensitive = true
}
variable "stripe_secret_key" {
  type      = string
  sensitive = true
  default   = "sk_test_placeholder"
}
variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = "whsec_placeholder"
}

resource "aws_secretsmanager_secret" "app" {
  name = "${var.name}/app"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL           = var.database_url
    MIGRATION_DATABASE_URL = var.migration_database_url
    JWT_SIGNING_SECRET     = var.jwt_signing_secret
    STRIPE_SECRET_KEY      = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET  = var.stripe_webhook_secret
  })
}

output "secret_arn" { value = aws_secretsmanager_secret.app.arn }
