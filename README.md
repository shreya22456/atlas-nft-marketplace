# Atlas NFT Marketplace

A React NFT marketplace, MetaMask wallet integration, Supabase API/database, and Solidity supply-chain demo for the Sepolia testnet.

For the full architecture, setup, API, database, contract, testing, and deployment guide, see [Atlas NFT Marketplace Project Documentation](./Atlas_NFT_Marketplace_Project_Documentation.docx).

## Features

- MetaMask connection, account updates, and Sepolia network switching
- ERC-721 minting, marketplace listings, and purchases through wallet-confirmed transactions
- ERC-2981 creator royalties and ReentrancyGuard-protected purchases
- Supabase asset metadata and confirmed transaction history
- Responsive marketplace, collection, and asset detail views

## Run the app

```bash
npm install
npm run dev
```

The frontend runs at `http://localhost:5173` and the API at `http://localhost:3001`. Node.js 22.13+ is required. Create a Supabase project, run `supabase/schema.sql` in its SQL Editor, and add `SUPABASE_URL` plus the server-only `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`. Seed listings are previews and cannot be purchased.

## Configure MetaMask and Sepolia

1. Copy `.env.example` to `.env.local`.
2. Set `SEPOLIA_RPC_URL` and `PRIVATE_KEY` locally, then run `npm run deploy:sepolia`. The script checks the chain ID and prints both contract addresses and Sepolia Etherscan links.
3. Set both `VITE_*_CONTRACT_ADDRESS` values in `.env.local`, and the non-prefixed contract address variables plus `SEPOLIA_RPC_URL` on the API host.
4. Restart the dev server after changing environment variables.

The marketplace listing storage layout changed for gas savings. Deploy a fresh marketplace contract after this update and replace the old marketplace address; this contract is not upgradeable.

Install MetaMask and connect it to Sepolia. Minting, listing, price updates, listing cancellation, product journey updates, and purchases require deployed contract addresses and Sepolia test ETH. The API checks confirmed Sepolia receipts and contract events before syncing them into Supabase. `GET /api/network` reports RPC and deployment status. Set `PINATA_JWT` in `.env.local` to pin uploaded images and metadata to IPFS; without it, metadata is served from the API.

## Compile, test, and deploy

```bash
npm run compile
npm test
npm run deploy:sepolia
```

The Hardhat suite currently has ten tests covering minting and royalties, buyer ownership transfer, supply-chain update permissions, listing price changes/cancellation, invalid marketplace actions, purchase payment splits, marketplace fee limits, invalid mint inputs, zero-address royalty edge cases, no-royalty collections, and gas budgets. The Solidity optimizer is enabled with 200 runs. In a local Hardhat measurement, listing used 81,166 gas (previous baseline 106,293) and purchasing used 103,089 gas (previous baseline 106,549); actual Sepolia gas varies with network state. Run tests locally; they do not deploy to Sepolia or use real funds.

## Database

The API persists assets and confirmed mint/list/purchase transactions in Supabase. Contract transactions are the source of truth; Supabase is the metadata store and index. Never expose the Supabase service-role key in a `VITE_*` variable or commit it to source control.

## Publish (Vercel + Supabase)

1. Push this repository to GitHub.
2. Create a Supabase project and run `supabase/schema.sql` in the SQL Editor.
3. In Vercel Project Settings → Environment Variables, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-only), plus `SEPOLIA_RPC_URL`, `NFT_CONTRACT_ADDRESS`, and `MARKETPLACE_CONTRACT_ADDRESS` for the API.
4. Set `VITE_NFT_CONTRACT_ADDRESS` and `VITE_MARKETPLACE_CONTRACT_ADDRESS` for the frontend after deploying contracts. Leave `VITE_API_URL` empty so the frontend uses the same Vercel domain.
5. Redeploy on Vercel after setting environment variables. Optionally add `PINATA_JWT` and `PUBLIC_API_URL` (the production Vercel URL).

Do not commit `.env`/`.env.local`, private keys, or the Supabase service-role key. `.env.example` contains placeholders only.
