# srnd-jira-proxy

Tiny zero-dependency Node service that lets the SRND Roadmap board change Jira
issue statuses. Holds no secrets in code — Jira creds + shared secret come from
environment variables (set in Railway).

## Env vars
- `JIRA_BASE` (default `https://atomoperations.atlassian.net`)
- `JIRA_EMAIL`
- `JIRA_TOKEN`
- `SHARED_SECRET`

## Endpoints
- `GET /health`
- `GET /transitions?key=SRND-123` — allowed target statuses (needs `X-Secret` header or `?secret=`)
- `POST /transition` `{ "key": "SRND-123", "targetStatus": "Today" }` — performs the transition
