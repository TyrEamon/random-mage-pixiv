# Random Mage Cloudflare deployment

Cloudflare-native public API for the free-plan deployment. It uses one metadata
D1 database and eight horizontally sharded catalog databases. The original
FastAPI/Docker deployment remains in the repository for self-hosting.

## Commands

```powershell
npm install
npm run types
npm run typecheck
npm run dry-run
npm run dev
```

Remote D1 migrations must be applied to `random-mage-meta` and each database
from `random-mage-00` through `random-mage-07` before the first deployment.
