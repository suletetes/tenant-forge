# IAM module (R17.3). Least-privilege ECS task execution role (pull image, read secret, logs)
# and task role (runtime app permissions — currently minimal).

variable "name" { type = string }
variable "secret_arn" { type = string }

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: used by the ECS agent to pull the image, fetch secrets, write logs.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scope secret access to exactly the app secret (least privilege).
data "aws_iam_policy_document" "secret_read" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "${var.name}-read-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secret_read.json
}

# Task role: runtime identity for the app itself (kept minimal; extend for X-Ray/SQS later).
resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "task_role_arn" { value = aws_iam_role.task.arn }
