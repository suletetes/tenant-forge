# CloudWatch alarms → SNS module (R19.2, R15.4). Alarms on ALB 5xx error rate, p99 target-response
# time, and a 429 spike, all notifying an SNS topic.

variable "name" { type = string }
variable "alb_arn_suffix" { type = string } # e.g. app/tenantforge-dev-alb/abc123
variable "target_group_arn_suffix" { type = string }
variable "alarm_email" {
  type    = string
  default = ""
}

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# 5xx error rate: alarm when the app returns too many 5xx over 5 minutes.
resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.name}-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Elevated 5xx responses from the app"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# p99 latency: alarm when the 99th-percentile target response time exceeds the NFR2.1 budget.
resource "aws_cloudwatch_metric_alarm" "p99_latency" {
  alarm_name          = "${var.name}-p99-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p99"
  threshold           = 0.4 # 400ms (writes budget, NFR2.1)
  alarm_description   = "p99 target response time above budget"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# 429 spike: the app emits a rate-limit metric; alarm on a burst indicating abuse or misconfig.
resource "aws_cloudwatch_metric_alarm" "rate_limit_spike" {
  alarm_name          = "${var.name}-429-spike"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_4XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "Spike in 4xx (incl. 429) — possible abuse or client misconfig"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
}

output "sns_topic_arn" { value = aws_sns_topic.alarms.arn }
