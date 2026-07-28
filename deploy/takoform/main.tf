terraform {
  required_version = ">= 1.5"

  required_providers {
    takoform = {
      source  = "registry.opentofu.org/tako0614/takoform"
      version = "= 0.1.2"
    }
  }
}

variable "project_name" {
  description = "Portable resource-name prefix for this Yurumeet instance."
  type        = string
  default     = "yurumeet"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "worker_release_tag" {
  description = "Yurumeet GitHub release containing takosumi-artifact.json."
  type        = string
  default     = "v0.1.2"

  validation {
    condition     = trimspace(var.worker_release_tag) == "" || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$", trimspace(var.worker_release_tag)))
    error_message = "worker_release_tag must be empty or a SemVer-like Git tag beginning with v."
  }
}

variable "worker_bundle_url" {
  description = "Immutable HTTPS Worker artifact URL pinned by this Yurumeet release."
  type        = string
  default     = "https://github.com/tako0614/yurumeet/releases/download/v0.1.2/worker.js"

  validation {
    condition     = can(regex("^https://[^[:space:]]+$", trimspace(var.worker_bundle_url)))
    error_message = "worker_bundle_url must be an https URL."
  }
}

variable "worker_bundle_sha256" {
  description = "Expected SHA-256 for the pinned Worker artifact."
  type        = string
  default     = "sha256:12dbf659613caa79c7e1696cb44a6078216bba92e61e812d3e84cd8d23370472"

  validation {
    condition     = can(regex("^(sha256:)?[a-f0-9]{64}$", trimspace(var.worker_bundle_sha256)))
    error_message = "worker_bundle_sha256 must be lowercase SHA-256 hex or sha256:<hex>."
  }
}

variable "worker_compatibility_date" {
  description = "Optional portable edge runtime compatibility-date override. Null uses the repo-owned wrangler.jsonc value."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.worker_compatibility_date == null || can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.worker_compatibility_date))
    error_message = "worker_compatibility_date must be null or use YYYY-MM-DD."
  }
}

variable "worker_compatibility_flags" {
  description = "Optional portable edge runtime compatibility-flag override. Null uses the repo-owned wrangler.jsonc values."
  type        = set(string)
  default     = null
  nullable    = true
}

locals {
  worker_runtime_config      = jsondecode(file("${path.module}/../../wrangler.jsonc"))
  worker_compatibility_date  = var.worker_compatibility_date != null ? var.worker_compatibility_date : local.worker_runtime_config.compatibility_date
  worker_compatibility_flags = var.worker_compatibility_flags != null ? var.worker_compatibility_flags : toset(local.worker_runtime_config.compatibility_flags)
  release_tag                = trimspace(var.worker_release_tag)
  artifact_url               = trimspace(var.worker_bundle_url)
  artifact_sha256            = trimspace(var.worker_bundle_sha256)
  artifact_sha256_checked    = startswith(local.artifact_sha256, "sha256:") ? local.artifact_sha256 : "sha256:${local.artifact_sha256}"
  prefix                     = var.project_name
}

resource "takoform_sql_database" "database" {
  name   = "${local.prefix}-db"
  engine = "sqlite"
}

resource "takoform_object_bucket" "media" {
  name          = "${local.prefix}-media"
  storage_class = "standard"
}

resource "takoform_kv_store" "kv" {
  name        = "${local.prefix}-kv"
  consistency = "eventual"
}

resource "takoform_queue" "delivery" {
  name           = "${local.prefix}-delivery"
  max_retries    = 3
  max_batch_size = 10
}

resource "takoform_queue" "delivery_dlq" {
  name           = "${local.prefix}-delivery-dlq"
  max_retries    = 1
  max_batch_size = 10
}

resource "takoform_edge_worker" "worker" {
  name                = local.prefix
  artifact_url        = local.artifact_url
  artifact_sha256     = local.artifact_sha256_checked
  compatibility_date  = local.worker_compatibility_date
  compatibility_flags = local.worker_compatibility_flags
  profiles            = ["workers_bindings"]

  connections = [
    {
      name        = "DB"
      resource    = takoform_sql_database.database.id
      permissions = ["connect", "read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "MEDIA"
      resource    = takoform_object_bucket.media.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "KV"
      resource    = takoform_kv_store.kv.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "DELIVERY_QUEUE"
      resource    = takoform_queue.delivery.id
      permissions = ["consume", "publish"]
      projection  = "runtime_binding"
    },
    {
      name        = "DELIVERY_DLQ"
      resource    = takoform_queue.delivery_dlq.id
      permissions = ["consume", "publish"]
      projection  = "runtime_binding"
    },
  ]

  lifecycle {
    precondition {
      condition     = strcontains(local.artifact_url, "/releases/download/${local.release_tag}/")
      error_message = "worker_bundle_url must select the exact worker_release_tag."
    }

    precondition {
      condition     = can(regex("^https://[^[:space:]]+$", local.artifact_url)) && can(regex("^sha256:[a-f0-9]{64}$", local.artifact_sha256_checked))
      error_message = "The selected Yurumeet Worker artifact must have an immutable HTTPS URL and SHA-256."
    }
  }
}

resource "takoform_schedule" "retention" {
  name     = "${local.prefix}-retention"
  cron     = "0 * * * *"
  timezone = "UTC"

  connections = [
    {
      name        = "WORKER"
      resource    = takoform_edge_worker.worker.id
      permissions = ["invoke"]
      projection  = "schedule_trigger"
    },
  ]
}
