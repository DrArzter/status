# Main is closed: changes arrive as pull requests, and Check has to pass.
# There is one maintainer, so no review is required — requiring one would make
# every change unmergeable. The admin bypass is deliberate and is the release
# valve for that, not a hole left open by accident.
resource "github_branch_protection" "main" {
  repository_id = var.github_repository
  pattern       = "main"

  # false leaves the owner able to merge past the gate when they choose to.
  enforce_admins = false

  required_status_checks {
    strict   = true
    contexts = ["check"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 0
    dismiss_stale_reviews           = true
    require_last_push_approval      = false
  }

  require_conversation_resolution = true
  allows_force_pushes             = false
  allows_deletions                = false
}
