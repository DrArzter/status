terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }

    github = {
      source  = "integrations/github"
      version = "~> 6"
    }
  }

  # State lives in R2, so this project depends on nothing outside Cloudflare.
  # The skip flags are what the S3 backend needs against an S3-compatible store
  # that is not AWS; `use_lockfile` replaces the DynamoDB table AWS would use.
  backend "s3" {
    bucket = "drarzter-tfstate"
    key    = "status/terraform.tfstate"
    region = "auto"

    endpoints                   = { s3 = "https://ACCOUNT_ID.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "github" {
  token = var.github_token
  owner = var.github_owner
}

# The history. Terraform owns it because losing it is losing the record;
# the Worker's code is deployed by wrangler, which is what bundles it.
resource "cloudflare_d1_database" "status" {
  account_id = var.account_id
  name       = "status"

  lifecycle {
    prevent_destroy = true
  }
}

# status.drarzter.dev answers from the Worker. A custom domain needs the zone to
# be active in this account, and it manages its own DNS record.
resource "cloudflare_workers_custom_domain" "status" {
  account_id  = var.account_id
  zone_id     = var.zone_id
  hostname    = var.hostname
  service     = var.worker_name
  environment = "production"
}
