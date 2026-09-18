variable "cloudflare_api_token" {
  description = "API token with Workers Scripts, D1 and DNS edit permissions."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "zone_id" {
  description = "Zone id of the domain the status page answers on."
  type        = string
}

variable "hostname" {
  description = "Where the page answers."
  type        = string
  default     = "status.drarzter.dev"
}

variable "worker_name" {
  description = "Worker service name, matching wrangler.jsonc."
  type        = string
  default     = "status"
}

variable "github_token" {
  description = "GitHub token with repository administration rights, for branch protection."
  type        = string
  sensitive   = true
}

variable "github_owner" {
  description = "GitHub account that owns the repository."
  type        = string
  default     = "DrArzter"
}

variable "github_repository" {
  description = "Repository name, as branch protection addresses it."
  type        = string
  default     = "status"
}
