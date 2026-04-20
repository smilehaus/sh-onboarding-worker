# Smile Haus Onboarding Worker — Setup Runbook

Cloudflare Worker that replaces Make.com for the Smile Haus onboarding automation.
This is the **one-time setup**. After this, the automation runs on its own.

## What this Worker does

- Handles ClickUp OAuth (so no Personal Access Tokens that can be regenerated and break everything)
- Creates the onboarding folder + 4 week lists + parent + 49 subtasks on ClickUp when the form submits
- Embeds correct `?taskId=` in each quiz task description at creation time (fixes the "wrong employee" quiz bug)
- Posts graded quiz results as comments on the exact task
- Lists active trainees for the quiz picker
- Auto-refreshes OAuth access tokens; self-heals on transient errors

## One-time setup steps

Do these in order. Most take seconds. The whole thing is ~20 minutes including OAuth click-through.

### 1. Sign up for Cloudflare (free)
- https://dash.cloudflare.com/sign-up
- Use `saomongmo@gmail.com`
- No billing info required

### 2. Install Wrangler locally (for the initial KV + secret setup)
```bash
cd "C:/Users/saomo/Desktop/SH Agents/apps/sh-onboarding-worker"
npm install
npx wrangler login
```
A browser opens — click Allow. Credentials saved locally (OAuth, not API tokens).

### 3. Create the KV namespace
```bash
npx wrangler kv namespace create sh_onboarding_kv
```
Copy the `id` from the output and paste it into `wrangler.toml` where it says `REPLACE_WITH_KV_ID`.

### 4. Set the ClickUp client secret as a Worker secret
```bash
npx wrangler secret put CLICKUP_CLIENT_SECRET
```
Paste the secret from your local `.env` (`CLICKUP_CLIENT_SECRET`). Never commit it.

### 5. (Optional) Set a ClickUp task ID for error notifications
Create a task in ClickUp you want errors posted to, copy its ID, then:
```bash
npx wrangler secret put ERROR_NOTIFY_TASK_ID
```

### 6. Deploy the Worker for the first time
```bash
npm run deploy
```
Output gives you a URL like `https://sh-onboarding.YOUR_SUBDOMAIN.workers.dev`.

### 7. Add the Worker callback URL to your ClickUp OAuth app
- Go to https://app.clickup.com/settings/team/INTEGRATIONS → Apps → "Smile Haus AI Agents" → Edit
- Add this Redirect URI: `https://sh-onboarding.YOUR_SUBDOMAIN.workers.dev/oauth/callback`
- Save

### 8. Complete the one-time OAuth
- Open `https://sh-onboarding.YOUR_SUBDOMAIN.workers.dev/oauth/start` in your browser
- Click Authorize on ClickUp's page
- You'll be redirected back to the onboarding form with `?connected=1`
- The Worker has now stored your refresh token. You never have to touch this again (unless revoked).

### 9. Set up GitHub auto-deploy
- In the Cloudflare dashboard → My Profile → API Tokens → Create Token
- Use the "Edit Cloudflare Workers" template
- Copy the token
- In GitHub, go to the `smilehaus/sh-onboarding-worker` repo → Settings → Secrets and variables → Actions → New repository secret:
  - Name: `CLOUDFLARE_API_TOKEN` — value: the token you just created
  - Name: `CLOUDFLARE_ACCOUNT_ID` — value: your account ID (shown on Cloudflare dashboard home, right sidebar)
- Done. From now on, every push to `main` auto-deploys.

## Health check after setup

```bash
curl https://sh-onboarding.YOUR_SUBDOMAIN.workers.dev/api/status
```
Should return:
```json
{
  "authenticated": true,
  "needs_reauth": false,
  "reauth_url": "https://sh-onboarding.YOUR_SUBDOMAIN.workers.dev/oauth/start",
  "last_error": null
}
```

## If anything stops working

Check `/api/status`. Three possible failure signals:

| `last_error` | `needs_reauth` | What to do |
|---|---|---|
| null | false | Healthy. Look elsewhere (the form, GitHub Pages, ClickUp itself). |
| shows an error | false | Error logged. Check the message. Usually a transient ClickUp 5xx — try again. |
| any | true | OAuth refresh token died. Visit `/oauth/start` on your laptop and reapprove. Takes 10 seconds. |

## Environment variables reference

| Name | Where | Value |
|---|---|---|
| `CLICKUP_CLIENT_ID` | wrangler.toml `[vars]` | Public. Already set. |
| `ALLOWED_ORIGIN` | wrangler.toml `[vars]` | Public. Already set to `https://smilehaus.github.io`. |
| `CLICKUP_CLIENT_SECRET` | Worker Secret | Set via `wrangler secret put` |
| `ERROR_NOTIFY_TASK_ID` | Worker Secret | Optional, for monitoring |
| `CLOUDFLARE_API_TOKEN` | GitHub Secret | For GH Actions deploy |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Secret | For GH Actions deploy |

## Costs

All within Cloudflare Workers free tier:
- 100,000 requests/day
- Paid tier only kicks in at $5/month if you exceed free tier
- Smile Haus onboarding volume: realistic ~50 requests/day. **Free forever for this use case.**
