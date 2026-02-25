# zkSync Era Token & Game Integration

An obfuscated excerpt from a production tool. Built with [Hono](https://hono.dev/) and deployed on [Cloudflare Workers](https://workers.cloudflare.com/), using [viem](https://viem.sh/) for on-chain interactions on the zkSync Era mainnet. Some names have been changed, and the imported libraries are not included. I included code that I myself wrote, not others on my team, and no imports. Just a demonstration of my ability to write in Typescript, interact with databases (it was postgres), and interact with zkSync styled tokens.

If you have any questions, please let me know. I would be happy to explain or elaborate on any of these points.

---

## What it does

Users participating in a campaign were allocated a number of zkSync Era tokens. The flow worked in two stages:

1. **Claim** — The user claims their tokens, triggering a `mint()` on the ERC-20 contract. Tokens are sent to a platform-managed wallet derived per-user.
2. **Exchange** — The user exchanges tokens for game balls within daily purchase windows. Each exchange calls `burn()` on the token contract, permanently destroying the tokens, and credits the user's ball balance in the database.
3. **Play** — Ball balances feed into a separate game layer (not included here).

A daily allotment system limits how many tokens a user can burn per day, calculated as `total mintable / 10` per window.

---

## Code structure

```
src/
├── Public/          # Cloudflare Worker — user-facing API
│   ├── zksyncera.controller.ts   # Hono route handlers
│   ├── zkSyncEraService.ts       # Service layer (mint, burn, inventory)
│   └── zksyncera.config.ts      # Purchase window schedule
│
└── Secure/          # Cloudflare Worker — internal service (separate deployment)
    ├── index.ts                  # /token/burn endpoint
    └── zksync-era.config.ts     # Chain/contract config
```

### Request flow

```
Client
  └─> POST /connect              — loads inventory + purchase windows
  └─> POST /claim-zksyncera      — mints tokens to user's wallet
  └─> POST /add-balls            — burns tokens, credits ball balance
        └─> Secure Worker: POST /token/burn
              └─> burn() on-chain via viem + zkSync paymaster
```

Session authentication on user-facing routes is handled by `checkSession()`, middleware from an internal package not included here.

---

## What's removed

- **Auth middleware** (`checkSession`) — internal session package, not included
- **Key derivation** (`derivePrivateKeyForService`) — per-user private key derivation from an internal KMS, referenced in `Secure/index.ts` but not shown
- **Wallet service** (`PLATFORM_WALLET`) — a separate internal Worker that maps user IDs to wallet addresses
- **Database schema** — table definitions for `userCampaignInventory` are in a shared internal package
- **Environment bindings** — Cloudflare `wrangler.toml` configs and secrets not included
- **Game layer** — the game itself that consumed ball balances is a separate service
