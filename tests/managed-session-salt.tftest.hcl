# All external providers are mocked, including every apply below. These runs
# exercise only the actual app graph and disposable synthetic provider state.
mock_provider "cloudflare" {}
mock_provider "http" {}
mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      id     = "synthetic-managed-salt-resource"
      result = "synthetic-session-salt-never-issued-000000000000000000000000000000"
    }
  }
}

variables {
  enable_cloudflare_resources     = true
  enable_cloudflare_worker_script = true
  cloudflare_account_id           = "00000000000000000000000000000000"
  worker_bundle_path              = "tests/fixtures/session-salt-worker.js"
  worker_release_tag              = ""
  worker_bundle_url               = ""
  worker_bundle_sha256            = ""
  app_url                         = "https://session-salt.example.test"
  encryption_key                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  auth_password_hash              = "test-only-bootstrap-credential"
  session_hash_salt               = ""
  manage_session_hash_salt        = true
}

run "explicit_managed_salt_plans_without_a_private_form_value" {
  command = plan
  assert {
    condition     = length(random_password.session_hash_salt) == 1 && random_password.session_hash_salt[0].length == 64 && !random_password.session_hash_salt[0].special
    error_message = "Explicit managed mode must plan one dedicated high-entropy salt."
  }
}

run "mocked_apply_uses_only_sensitive_secret_text" {
  command = apply
  assert {
    condition     = issensitive(random_password.session_hash_salt[0].result)
    error_message = "The managed salt must remain sensitive."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "YURUCOMMU_SESSION_HASH_SALT" && binding.type == "secret_text" && binding.text == random_password.session_hash_salt[0].result
    ]) == 1
    error_message = "Deliver exactly the dedicated managed salt as secret_text."
  }
  assert {
    condition = issensitive(one([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "YURUCOMMU_SESSION_HASH_SALT"
    ]).text)
    error_message = "The delivered salt must preserve sensitivity."
  }
}

run "ordinary_update_keeps_managed_salt" {
  command = plan
  variables {
    project_name = "renamed-yurumeet"
  }
  assert {
    condition     = random_password.session_hash_salt[0].id == "synthetic-managed-salt-resource"
    error_message = "A service rename must not replace the salt resource."
  }
}

run "worker_pause_retains_managed_salt_state" {
  command = apply
  variables {
    enable_cloudflare_worker_script = false
  }
  assert {
    condition     = length(cloudflare_workers_script.worker) == 0 && length(random_password.session_hash_salt) == 1
    error_message = "Pausing a Worker must retain the explicitly managed salt."
  }
}

run "reenabling_worker_keeps_the_same_salt" {
  command = plan
  assert {
    condition     = random_password.session_hash_salt[0].id == "synthetic-managed-salt-resource"
    error_message = "Re-enabling a Worker must retain the managed salt resource."
  }
  assert {
    condition     = nonsensitive(random_password.session_hash_salt[0].result) == "synthetic-session-salt-never-issued-000000000000000000000000000000"
    error_message = "Re-enabling a Worker must reuse the retained synthetic salt."
  }
}

run "removing_management_without_replacement_is_refused" {
  command = plan
  variables {
    manage_session_hash_salt = false
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "explicit_manual_salt_conflicts_with_management" {
  command = plan
  variables {
    session_hash_salt = "synthetic-existing-manual-salt"
  }
  expect_failures = [random_password.session_hash_salt]
}

run "configured_whitespace_is_not_a_generation_fallback" {
  command = plan
  variables {
    session_hash_salt = " \n\t "
  }
  expect_failures = [random_password.session_hash_salt]
}

run "manual_mode_keeps_exact_existing_salt" {
  command = plan
  variables {
    manage_session_hash_salt = false
    session_hash_salt        = "  synthetic-existing-manual-salt  "
  }
  assert {
    condition     = length(random_password.session_hash_salt) == 0
    error_message = "Manual mode must not generate a replacement salt."
  }
  assert {
    condition = alltrue([
      for binding in cloudflare_workers_script.worker[0].bindings : binding.text == var.session_hash_salt && binding.type == "secret_text"
      if binding.name == "YURUCOMMU_SESSION_HASH_SALT"
    ])
    error_message = "Manual mode must preserve exact existing salt bytes."
  }
}

run "missing_auth_is_refused_before_generating_salt" {
  command = plan
  variables {
    auth_password_hash = ""
  }
  expect_failures = [random_password.session_hash_salt]
}

run "missing_oidc_owner_is_still_refused" {
  command = plan
  variables {
    auth_password_hash             = ""
    takosumi_accounts_issuer_url   = "https://accounts.example.test"
    takosumi_accounts_client_id    = "synthetic-client"
    takosumi_accounts_redirect_uri = "https://session-salt.example.test/api/auth/callback/takos"
  }
  expect_failures = [random_password.session_hash_salt]
}

run "explicit_pinned_oidc_fixture_is_valid" {
  command = plan
  variables {
    auth_password_hash             = ""
    takosumi_accounts_issuer_url   = "https://accounts.example.test"
    takosumi_accounts_client_id    = "synthetic-client"
    takosumi_accounts_redirect_uri = "https://session-salt.example.test/api/auth/callback/takos"
    oidc_owner_sub                 = "synthetic-client-specific-owner-subject"
  }
  assert {
    condition     = length(random_password.session_hash_salt) == 1
    error_message = "The existing explicit owner-pin contract must remain usable."
  }
}

run "mismatched_callback_is_refused_before_generating_salt" {
  command = plan
  variables {
    auth_password_hash             = ""
    takosumi_accounts_issuer_url   = "https://accounts.example.test"
    takosumi_accounts_client_id    = "synthetic-client"
    takosumi_accounts_redirect_uri = "https://other.example.test/api/auth/callback/takos"
    oidc_owner_sub                 = "synthetic-client-specific-owner-subject"
  }
  expect_failures = [random_password.session_hash_salt]
}

run "managed_mode_cannot_use_plaintext_env" {
  command = plan
  variables {
    env = {
      YURUCOMMU_SESSION_HASH_SALT = "synthetic-plaintext-salt"
    }
  }
  expect_failures = [var.env]
}
