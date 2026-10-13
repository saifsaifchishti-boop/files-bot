# GitHub + Heroku — settings restart ke baad bhi save rehti hain

## Kyun zaroori hai
Heroku ki disk har restart (kam az kam roz ek baar) par saaf ho jati hai. Isliye `data/` (group settings, warnings, cards,
prefs …) aur `session/` (WhatsApp login) **free Upstash Redis** mein save hote hain aur bot start hone se pehle wapas aa jate hain.
Koi extra npm package nahi chahiye.

## Step 1 — Upstash (free, 2 minute)
1. https://upstash.com par account banao → **Create Database** (Redis) → region Heroku ke qareeb (US-East / EU).
2. Database page → **REST API** → `UPSTASH_REDIS_REST_URL` aur `UPSTASH_REDIS_REST_TOKEN` copy karo.

## Step 2 — GitHub
```
git init
git add .
git commit -m "Mehfooz bot"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```
Repo **Private** rakho. `.env` kabhi upload mat karo (`.gitignore` isay rokta hai).

## Step 3 — Heroku
1. Heroku → New app → Deploy → **GitHub** se repo connect → Deploy Branch.
2. Settings → **Config Vars** mein daalo:
   - `PANEL_PASSWORD` = apna dashboard password (zaroori! warna admin/admin rahega)
   - `UPSTASH_REDIS_REST_URL` aur `UPSTASH_REDIS_REST_TOKEN`
   - `HOST` = `0.0.0.0`
   - optional: `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`
   - `PORT` mat daalo (Heroku khud deta hai)
3. Resources → `web` dyno ON. App kholo, dashboard se WhatsApp link karo (sirf pehli baar).
4. Logs mein ye line aani chahiye: `[persist] saving settings every 10s …`

## Dhyan
- **Eco dyno 30 minute baad so jata hai** (bot offline). Bot 24/7 chahiye to **Basic** dyno lo.
- Settings har 10 second mein, WhatsApp session har 45 second mein save hoti hai; restart/SIGTERM par bhi turant save hota hai.
- Agar Redis se nahi parha ja saka, bot us run mein save band rakhta hai taake purana data kabhi overwrite na ho.
- Test: `npm run aitest`

## "Deploy to Heroku" button (optional)
`README.md` ke sab se upar button laga diya hai. Usay chalane ke liye:
1. README.md mein `YOUR_GITHUB_USERNAME` / `YOUR_REPO_NAME` badlo.
2. Repo **Public** karo (button private repo par nahi chalta). Public karne se pehle yaqeen karo ke `.env` upload nahi hui.
3. GitHub repo ke page par README ke upar button dikhega; click karo → Heroku khulega → Config Vars (PANEL_PASSWORD, Upstash URL/token) bharo → Deploy.
Private rakhna ho to button ki jagah Step 3 (GitHub connect) use karo.
