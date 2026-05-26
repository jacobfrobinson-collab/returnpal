# Agent / contributor notes

## Git and GitHub

After completing a substantive change set (features, fixes, tests), **commit and push** to `origin` on the current branch with a clear message. Do not leave completed work only on a local machine unless the task explicitly says not to publish yet.

- Prefer `git add -u` plus explicit `git add` for new files you added.
- Do not commit secrets, real `.env` files, or large private dumps.
- Untracked one-off scripts under `scripts/` should only be added if they are meant to be shared; otherwise leave them untracked and mention them in the PR or summary.

## Tests

Run `npm run test:unit` before pushing when you touch date, invoice, or sold-date logic. Use `npm test` when the API server is running for integration checks.

## Production environment

Document signup and secrets in repo templates only — never commit real `.env` files:

- [`production.env.example`](production.env.example) — includes `SIGNUP_REQUIRE_ADMIN_APPROVAL=1`
- [`docs/PRODUCTION_ENV.md`](docs/PRODUCTION_ENV.md) — operator guide

Set live values on the hosting provider, then restart the Node process.
