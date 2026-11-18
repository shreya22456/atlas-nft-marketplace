# Atlas NFT Marketplace

A React NFT marketplace, MetaMask wallet integration, SQLite API, and Solidity supply-chain demo for the Sepolia testnet.

## Features

- MetaMask connection, account updates, and Sepolia network switching
- ERC-721 minting, marketplace listings, and purchases through wallet-confirmed transactions
- ERC-2981 creator royalties and ReentrancyGuard-protected purchases
- SQLite asset metadata and confirmed transaction history
- Responsive marketplace, collection, and asset detail views

## Run the app

```bash
npm install
npm run dev
```

The frontend runs at `http://localhost:5173` and the API at `http://localhost:3001`. Node.js 22.13+ is required for the built-in SQLite driver. The local database is created at `data/atlas.sqlite`. Seed listings are previews and cannot be purchased.

## Configure MetaMask and Sepolia

1. Copy `.env.example` to `.env.local`.
2. Deploy the contracts and set `VITE_NFT_CONTRACT_ADDRESS` and `VITE_MARKETPLACE_CONTRACT_ADDRESS`.
3. Configure `SEPOLIA_RPC_URL` and `PRIVATE_KEY` for deployment.
4. Restart the dev server after changing environment variables.

Install MetaMask and connect it to Sepolia. Minting, listing, and purchases require deployed contract addresses and Sepolia test ETH. Set `PINATA_JWT` in `.env.local` to pin uploaded images and metadata to IPFS; without it, metadata is served from the local API.

## Compile, test, and deploy

```bash
npm run compile
npm test
npx hardhat run scripts/deploy.cjs --network sepolia
```

## Database

The API persists assets and confirmed mint/list/purchase transactions in SQLite. Set `DATABASE_PATH` to change the database location. Contract transactions are the source of truth; SQLite is the local metadata store and index.

## Publish (Vercel + Render)

1. Push this repository to GitHub.
2. On Render, create a Blueprint from the repository and apply `render.yaml`. The attached persistent disk is required for SQLite and uses Render's paid Starter plan.
3. Set Render's `PUBLIC_API_URL` to the Render service URL, `CORS_ORIGIN` to the Vercel site URL, and optionally set `PINATA_JWT`.
4. On Vercel, import the same GitHub repository and set `VITE_API_URL` to the Render service URL. Set the two `VITE_*_CONTRACT_ADDRESS` variables after deploying contracts.
5. Redeploy both services after setting environment variables.

Do not commit `.env`/`.env.local`, private keys, or the SQLite database. `.env.example` contains placeholders only.
