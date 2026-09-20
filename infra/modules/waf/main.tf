# WAF module (R19.1). OWASP-style protection via AWS managed rule groups, associated with the ALB.

variable "name" { type = string }
variable "alb_arn" { type = string }

resource "aws_wafv2_web_acl" "this" {
  name  = "${var.name}-waf"
  scope = "REGIONAL" # ALB is regional (CLOUDFRONT scope is for CloudFront)

  default_action {
    allow {}
  }

  # AWS Managed: Core rule set (OWASP Top 10 coverage).
  rule {
    name     = "AWSManagedCommon"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed: Known bad inputs.
  rule {
    name     = "AWSManagedBadInputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-badinputs"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed: SQL injection rule set.
  rule {
    name     = "AWSManagedSQLi"
    priority = 3
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-sqli"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

output "web_acl_arn" { value = aws_wafv2_web_acl.this.arn }
