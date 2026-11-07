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
   and codebase, for example `npx --yes --package firebase-tools@15.34.2 firebase
   deploy --project tieryourlife --only functions:default --non-interactive`. Verify actual deployment status and a
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

## Existing command path

Run with this repository as the absolute working directory. Replace `PR` with
the accepted PR number. For future PRs, when required-check protection and
auto-merge are enabled, use `gh pr merge PR --repo
kellygracelab-dotcom/tieryourlife-proxy --auto --squash`; this queues a merge,
so wait for `gh pr view PR --json state,mergeCommit` to confirm `MERGED`.
Inspect `gh pr checks PR --repo kellygracelab-dotcom/tieryourlife-proxy` first.

Then `git -C D:/MyProjects/TierYourLife/TierYourLifeProxy fetch --prune origin`,
`git -C D:/MyProjects/TierYourLife/TierYourLifeProxy switch main` and
`git -C D:/MyProjects/TierYourLife/TierYourLifeProxy pull --ff-only` (preserving
any separate local work). Check main CI for that SHA, run `npm --prefix
functions run check`, then `npx --yes --package firebase-tools@15.34.2 firebase
deploy --project tieryourlife --only functions:default --non-interactive` using the already configured local CLI
session. Do not open/export authentication files to enable cloud deployment.

Use the same pinned CLI as CI: local global CLI 15.27 crashed during source
discovery in this release, while 15.34.2 completed the deploy. Confirm function
state and source/hash metadata using `npx --yes --package firebase-tools@15.34.2
firebase functions:list --project tieryourlife --non-interactive --json`.
Capture this JSON in the command process and emit/save only an allowlist:
id, region, codebase, state, hash, source, uri, availableMemoryMb, cpu,
maxInstances and concurrency. Never print the raw JSON or environment fields.
Compare pre/post metadata and preserve other codebases/capacity. If gcloud has
an already configured account it can also return selected revision fields;
gcloud authentication is not required for the existing Firebase CLI path.
A token-free read-only request such as
`curl.exe -i https://europe-west1-tieryourlife.cloudfunctions.net/lists/categories`
may correctly return an authentication refusal: record the actual status and
distinguish availability/security smoke from an authenticated feature test.
Save deploy log, main SHA and smoke evidence on D: before cleaning branches.
