# Plan-only release input contract. Providers are mocked and the Worker is
# disabled, so these cases do not fetch a GitHub asset or publish resources.
mock_provider "cloudflare" {}
mock_provider "http" {}
mock_provider "random" {}

variables {
  enable_cloudflare_resources     = false
  enable_cloudflare_worker_script = false
  worker_bundle_sha256            = "3b952ec6c0ee048bfd303344f8053c21c01ae8bdca780db57c908c6e171d1bd0"
}

run "selected_tag_exact_asset_url" {
  command = plan
  variables {
    worker_release_tag = "v0.2.0"
    worker_bundle_url  = "https://github.com/tako0614/yurumeet/releases/download/v0.2.0/worker.js"
  }
}

run "selected_tag_wrong_asset_url_refused" {
  command = plan
  variables {
    worker_release_tag = "v0.2.0"
    worker_bundle_url  = "https://github.com/tako0614/yurumeet/releases/download/v0.1.2/worker.js"
  }
  expect_failures = [var.worker_bundle_url]
}

run "selected_tag_custom_asset_url_refused" {
  command = plan
  variables {
    worker_release_tag = "v0.2.0"
    worker_bundle_url  = "https://example.invalid/worker.js"
  }
  expect_failures = [var.worker_bundle_url]
}

run "empty_tag_custom_asset_url_allowed" {
  command = plan
  variables {
    worker_release_tag = ""
    worker_bundle_url  = "https://example.invalid/worker.js"
  }
}
