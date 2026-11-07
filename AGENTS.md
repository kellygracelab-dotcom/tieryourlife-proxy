# TierYourLife Proxy

Read the product rules in `../AGENTS.md` when present and the relevant contract
in `CONTRACT.md`. This repository owns Firebase Functions codebase `default`;
Web Functions and Hosting belong to the Web repository.

## Completing ordinary changes

Danylo's standing instruction of 2026-11-08 is to finish authorized changes
through delivery, rather than leave tested work on a branch:

1. Keep Android/Web compatibility explicit. Run `npm --prefix functions run
   check`, inspect the diff and open a PR against `main`.
2. Wait for all applicable jobs in `.github/workflows/ci.yml`: build/tests,
   Website against this proxy and App against this proxy. Check that their SHA
   belongs to the final PR code. Do not bypass failed checks or weaken them.
3. Merge the green PR, update the canonical local checkout to `origin/main`,
   and verify the resulting source tree and main checks.
4. Deploy that revision using the existing Firebase CLI and an explicit project
   and codebase, for example `firebase deploy --project tieryourlife --only
   functions:default --non-interactive`. Verify actual deployment status and a
   harmless read-only smoke. Tell dependent clients when production is ready.
   A merged commit alone is not proof of deployment.
5. Delete only completed, verified merged branches on origin and locally.
   Inspect local leftovers before deleting exact, resolved paths inside this
   repository. Preserve unrelated work, credentials, backups and QA evidence
   under `../qa-results`; never use a blanket `git clean -xfd`.
6. Report the PR, main SHA, CI/deploy evidence, smoke outcome and cleanup.

Use the existing CI; do not create a second deployment mechanism or add stored
credentials just to automate this procedure. Never print secrets or read .env,
credentials or signing keys. Rules, indexes, account/security settings, data
migrations and destructive production operations need their own task scope.
