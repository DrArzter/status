output "d1_database_id" {
  description = "Paste into wrangler.jsonc, or read it from CI."
  value       = cloudflare_d1_database.status.id
}

output "hostname" {
  value = cloudflare_workers_custom_domain.status.hostname
}
