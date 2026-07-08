output "takosumi_release" {
  value = {
    post_apply = concat(
      local.cloudflare_worker_enabled ? [
        {
          id                = "migrate"
          executor          = "runner"
          command           = ["bun", "run", "takosumi:release", "--", "--migrations-only"]
          working_directory = "."
        },
      ] : [],
      local.cloudflare_worker_enabled ? [] : [
        {
          id                = "release"
          executor          = "operator"
          command           = ["bun", "run", "takosumi:release"]
          working_directory = "."
        },
      ],
    )
    pre_destroy = local.cloudflare_worker_enabled ? [] : [
      {
        id                = "release-destroy"
        executor          = "operator"
        command           = ["bun", "run", "takosumi:release", "--", "--destroy"]
        working_directory = "."
      },
    ]
  }
}

output "worker_name" {
  description = "Cloudflare Worker name used when enable_cloudflare_worker_script is true."
  value       = local.worker_name
}

output "worker_managed_by_opentofu" {
  description = "True when the Worker script, bindings, assets, queue consumers, and workers.dev enablement are managed by OpenTofu."
  value       = local.cloudflare_worker_enabled
}

output "cloudflare_worker_script_id" {
  description = "OpenTofu-managed Cloudflare Worker script ID, or null when enable_cloudflare_worker_script is false."
  value       = try(cloudflare_workers_script.worker[0].id, null)
}

output "cloudflare_worker_route_id" {
  description = "OpenTofu-managed Cloudflare Worker route ID, or null when cloudflare_route_zone_id/cloudflare_route_pattern are not set."
  value       = try(cloudflare_workers_route.worker[0].id, null)
}

output "launch_url" {
  description = "Public URL for the published Yurumeet instance, when the Capsule has enough hostname input to derive it."
  value       = local.launch_url
}

output "url" {
  description = "Alias for launch_url for generic Takosumi public URL smoke checks."
  value       = local.launch_url
}

output "social_api_base_url" {
  description = "Client-neutral base URL for the Yurumeet social API."
  value       = local.launch_url
}

output "activitypub_origin" {
  description = "Canonical ActivityPub actor/object origin for the Yurumeet social server."
  value       = local.launch_url
}

output "media_origin" {
  description = "Public media URL origin/path for clients connected to this social server."
  value       = local.launch_url != null ? "${local.launch_url}/media" : null
}

output "social_server_capabilities_url" {
  description = "Well-known discovery URL for the shared social server capabilities."
  value       = local.launch_url != null ? "${local.launch_url}/.well-known/social-server" : null
}

output "mobile_push_registration_url" {
  description = "Mobile/web push registration endpoint for Yurumeet-compatible clients."
  value       = local.launch_url != null ? "${local.launch_url}/api/mobile/push-registrations" : null
}

output "app_deployment" {
  description = "Installable app declaration consumed from tofu output -json by Takos/Takosumi install flows."
  value = {
    contractVersion = 1
    name            = "yurumeet"
    version         = "0.1.0"

    compute = {
      web = {
        kind      = "worker"
        readiness = "/healthz"
        triggers = {
          queues = [
            {
              binding         = "DELIVERY_QUEUE"
              deadLetterQueue = "delivery_dlq"
              maxBatchSize    = 10
              maxRetries      = 3
              maxWaitTimeMs   = 1000
            },
            {
              binding       = "DELIVERY_DLQ"
              maxBatchSize  = 10
              maxRetries    = 1
              maxWaitTimeMs = 60000
            },
          ]
        }
      }
    }

    resources = {
      database = {
        type = "sql"
        bind = "DB"
        to   = ["web"]
      }
      media = {
        type = "object-store"
        bind = "MEDIA"
        to   = ["web"]
      }
      kv = {
        type = "key-value"
        bind = "KV"
        to   = ["web"]
      }
      delivery = {
        type = "queue"
        bind = "DELIVERY_QUEUE"
        to   = ["web"]
        queue = {
          deadLetterQueue = "delivery_dlq"
          maxRetries      = 3
        }
      }
      delivery_dlq = {
        type = "queue"
        bind = "DELIVERY_DLQ"
        to   = ["web"]
        queue = {
          maxRetries = 1
        }
      }
    }

    routes = [
      {
        id     = "root"
        target = "web"
        path   = "/"
      },
    ]

    publish = [
      {
        name      = "launcher"
        publisher = "web"
        type      = "interface.ui.surface"
        outputs = {
          url = {
            kind     = "url"
            routeRef = "root"
          }
        }
        display = {
          title       = "Yurumeet"
          description = "Self-hosted talk-first ActivityPub app for messaging, stories, and small communities."
          icon        = "/icon.svg"
          category    = "social"
        }
        spec = {
          launcher = true
        }
      },
    ]

    env = {
      APP_URL = local.launch_url != null ? local.launch_url : ""
    }
  }
}


output "service_exports" {
  description = "OpenTofu output projection for launch and endpoint metadata without Takosumi-specific resource descriptors."
  value = [
    {
      name         = "social-api"
      capabilities = ["protocol.http.api"]
      endpoints = [
        {
          name       = "default"
          protocol   = "https"
          pathPrefix = "/api"
          url        = local.launch_url != null ? "${local.launch_url}/api" : null
        },
        {
          name       = "discovery"
          protocol   = "https"
          pathPrefix = "/.well-known/social-server"
          url        = local.launch_url != null ? "${local.launch_url}/.well-known/social-server" : null
        },
      ]
      metadata = {
        title              = "Yurumeet Server"
        description        = "Talk-first social API for Yurumeet, Yurucommu, and compatible clients."
        canonicalOrigin    = local.launch_url
        activitypubOrigin  = local.launch_url
        capabilityIds      = ["api.social.v1"]
        supportedClientIds = ["yurume", "yurucommu"]
        clientDisplayNames = {
          yurume    = "Yurumeet"
          yurucommu = "Yurucommu"
        }
        defaultClientEntries = {
          yurume    = "messages"
          yurucommu = "feed"
        }
      }
      visibility = "space"
    },
    {
      name         = "activitypub"
      capabilities = ["protocol.http.api"]
      endpoints = [
        {
          name       = "actors"
          protocol   = "https"
          pathPrefix = "/ap"
          url        = local.launch_url != null ? "${local.launch_url}/ap" : null
        },
        {
          name       = "webfinger"
          protocol   = "https"
          pathPrefix = "/.well-known/webfinger"
          url        = local.launch_url != null ? "${local.launch_url}/.well-known/webfinger" : null
        },
      ]
      metadata = {
        title             = "Yurumeet ActivityPub Server"
        description       = "Canonical ActivityPub identity and federation surface for this talk-first social server."
        canonicalOrigin   = local.launch_url
        activitypubOrigin = local.launch_url
        capabilityIds     = ["activitypub.server.v1"]
      }
      visibility = "space"
    },
    {
      name         = "launcher"
      capabilities = ["interface.ui.surface"]
      endpoints = [
        {
          name       = "default"
          protocol   = "https"
          pathPrefix = "/"
          url        = local.launch_url
        }
      ]
      metadata = {
        title       = "Yurumeet"
        description = "Your own self-hosted talk app with ActivityPub identity, messaging, stories, and community reach."
        icon        = "/icon.svg"
        category    = "social"
      }
      visibility = "space"
    },
  ]
}

output "service_bindings" {
  description = "Runtime service grants requested by Yurumeet without Takos-specific resource descriptors."
  value = [
    {
      name = "web_launcher"
      target = {
        kind = "workload"
        name = "web"
        metadata = {
          componentKind = "worker"
        }
      }
      selector = {
        name         = "launcher"
        producer     = "self"
        capabilities = ["interface.ui.surface"]
      }
      grant_request = {
        scopes   = []
        audience = ["web"]
        env      = ["APP_URL"]
        metadata = {
          inject = {
            env = {
              url = "APP_URL"
            }
          }
        }
      }
    },
    {
      name = "web_identity_oidc"
      target = {
        kind = "workload"
        name = "web"
        metadata = {
          componentKind = "worker"
        }
      }
      selector = {
        name         = "identity.oidc"
        capabilities = ["identity.oidc"]
      }
      grant_request = {
        scopes   = ["openid", "profile", "email"]
        audience = ["web"]
        env = [
          "TAKOSUMI_ACCOUNTS_ISSUER_URL",
          "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        ]
        metadata = {
          sourceRef = "takosumi.identity.oidc"
        }
      }
    },
  ]
}

output "cloudflare_account_id" {
  description = "Cloudflare account id used for the Yurumeet backing resources, or null when Cloudflare resource provisioning is disabled."
  value       = local.cloudflare_resources_enabled ? var.cloudflare_account_id : null
}

output "cloudflare_d1_database_id" {
  description = "D1 database id for the DB binding, or null when Cloudflare resource provisioning is disabled."
  value       = try(cloudflare_d1_database.database[0].id, null)
}

output "cloudflare_d1_database_name" {
  description = "D1 database name for the DB binding."
  value       = local.d1_database_name
}

output "cloudflare_r2_bucket_name" {
  description = "R2 bucket name for the MEDIA binding."
  value       = local.r2_media_bucket
}

output "cloudflare_kv_namespace_id" {
  description = "Workers KV namespace id for the KV binding, or null when Cloudflare resource provisioning is disabled."
  value       = try(cloudflare_workers_kv_namespace.kv[0].id, null)
}

output "cloudflare_queue_names" {
  description = "Cloudflare Queue names for the delivery queue bindings."
  value = {
    delivery     = local.delivery_queue_name
    delivery_dlq = local.delivery_dlq_name
  }
}

output "cloudflare_binding_summary" {
  description = "Non-secret binding names and backing resource names used by the Yurumeet Worker artifact activation command."
  value = {
    worker = {
      name       = local.worker_name
      launch_url = local.launch_url
    }
    db = {
      binding       = "DB"
      database_name = local.d1_database_name
      database_id   = try(cloudflare_d1_database.database[0].id, null)
    }
    media = {
      binding     = "MEDIA"
      bucket_name = local.r2_media_bucket
    }
    kv = {
      binding      = "KV"
      namespace_id = try(cloudflare_workers_kv_namespace.kv[0].id, null)
    }
    queues = {
      delivery = {
        binding = "DELIVERY_QUEUE"
        name    = local.delivery_queue_name
      }
      delivery_dlq = {
        binding = "DELIVERY_DLQ"
        name    = local.delivery_dlq_name
      }
    }
  }
}
