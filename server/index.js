import dotenv from 'dotenv'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

const app = express()
const port = Number(process.env.PORT || process.env.API_PORT || 3001)
const databasePath = resolve(process.env.DATABASE_PATH || 'data/atlas.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })
const db = new DatabaseSync(databasePath)

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT,
    nft_address TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    image TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL,
    owner TEXT NOT NULL,
    price_eth TEXT NOT NULL DEFAULT '',
    price_wei TEXT NOT NULL DEFAULT '',
    royalty_bps INTEGER NOT NULL DEFAULT 500,
    status TEXT NOT NULL DEFAULT 'Draft',
    is_listed INTEGER NOT NULL DEFAULT 0,
    is_demo INTEGER NOT NULL DEFAULT 0,
    token_uri TEXT NOT NULL DEFAULT '',
    tx_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS assets_contract_token
    ON assets(nft_address, token_id) WHERE token_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    type TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL DEFAULT '',
    amount_wei TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  PRAGMA foreign_keys = ON;
`)

const count = db.prepare('SELECT COUNT(*) AS count FROM assets').get().count
if (count === 0) {
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO assets (name, category, image, creator, owner, price_eth, status, is_listed, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `)
  const samples = [
    ['Atlas Oak', 'Fashion', 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=85', '0x71C4…8a91', '0x71C4…8a91', '0.085', 'Manufactured'],
    ['Luna Chronograph', 'Luxury', 'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=900&q=85', '0x8B22…4D70', '0x8B22…4D70', '0.42', 'Shipped'],
    ['Terra No. 7', 'Collectible', 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=900&q=85', '0x3aF1…19C2', '0x3aF1…19C2', '0.18', 'Received'],
    ['Studio 54 Chair', 'Design', 'https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?auto=format&fit=crop&w=900&q=85', '0x12D8…77Ee', '0x12D8…77Ee', '0.64', 'Sold'],
  ]
  for (const sample of samples) insert.run(...sample, now, now)
}

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.get('origin')
  if (origin && (!allowedOrigins.length || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '4mb' }))

function mapAsset(row) {
  if (!row) return null
  return {
    ...row,
    image: row.image.startsWith('ipfs://')
      ? `https://gateway.pinata.cloud/ipfs/${row.image.slice('ipfs://'.length)}`
      : row.image,
    is_listed: Boolean(row.is_listed),
    is_demo: Boolean(row.is_demo),
    royalty_bps: Number(row.royalty_bps),
  }
}

async function pinToPinata(path, body, isFile = false) {
  const response = await fetch(`https://api.pinata.cloud/pinning/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
      ...(!isFile && { 'Content-Type': 'application/json' }),
    },
    body: isFile ? body : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text()
    const error = new Error(`Pinata upload failed (${response.status}): ${detail.slice(0, 300)}`)
    error.statusCode = 502
    throw error
  }
  const result = await response.json()
  return `ipfs://${result.IpfsHash}`
}

async function pinImage(image, name) {
  if (image.startsWith('ipfs://') || image.startsWith('https://')) return image
  const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/)
  if (!match) throw new Error('Unsupported image data')
  const [, mimeType, encoded] = match
  const extension = mimeType.split('/')[1].replace('jpeg', 'jpg')
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(encoded, 'base64')], { type: mimeType }), `${name}.${extension}`)
  return pinToPinata('pinFileToIPFS', form, true)
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
}

function isImage(value) {
  return typeof value === 'string' && (
    /^https:\/\/\S+$/i.test(value) ||
    /^ipfs:\/\/\S+$/i.test(value) ||
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value)
  )
}

function recordTransaction(assetId, type, txHash, fromAddress, toAddress = '', amountWei = '') {
  db.prepare(`
    INSERT INTO transactions (asset_id, type, tx_hash, from_address, to_address, amount_wei, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(assetId, type, txHash, fromAddress, toAddress, amountWei, new Date().toISOString())
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: 'sqlite' }))

app.get('/api/assets', (req, res) => {
  const owner = typeof req.query.owner === 'string' ? req.query.owner.toLowerCase() : ''
  const rows = owner
    ? db.prepare('SELECT * FROM assets WHERE lower(owner) = ? AND is_demo = 0 ORDER BY id DESC').all(owner)
    : db.prepare('SELECT * FROM assets WHERE is_listed = 1 ORDER BY is_demo DESC, id DESC').all()
  res.json(rows.map(mapAsset))
})

app.get('/api/assets/:id', (req, res) => {
  const asset = mapAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id))
  if (!asset) return res.status(404).json({ error: 'Asset not found' })
  const transactions = db.prepare('SELECT type, tx_hash, from_address, to_address, amount_wei, created_at FROM transactions WHERE asset_id = ? ORDER BY id ASC').all(req.params.id)
  res.json({ ...asset, transactions })
})

app.get('/api/assets/:id/metadata', (req, res) => {
  const asset = db.prepare('SELECT name, description, image, category FROM assets WHERE id = ?').get(req.params.id)
  if (!asset) return res.status(404).json({ error: 'Metadata not found' })
  res.json({
    name: asset.name,
    description: asset.description,
    image: asset.image,
    attributes: [{ trait_type: 'Category', value: asset.category }],
  })
})

app.post('/api/assets', async (req, res, next) => {
  try {
    const { name, description = '', category, image, origin = '', creator, royaltyBps = 500 } = req.body
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Enter an asset name of 1–100 characters' })
    if (typeof category !== 'string' || !category.trim() || category.length > 60) return res.status(400).json({ error: 'Enter a category of 1–60 characters' })
    if (typeof description !== 'string' || description.length > 2000) return res.status(400).json({ error: 'Description must be at most 2,000 characters' })
    if (!isImage(image) || image.length > 3_000_000) return res.status(400).json({ error: 'Upload a supported image under 2 MB, or use an HTTPS image URL' })
    if (!isAddress(creator)) return res.status(400).json({ error: 'A valid connected wallet is required' })
    if (typeof origin !== 'string' || origin.length > 120) return res.status(400).json({ error: 'Origin must be at most 120 characters' })
    if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 1000) return res.status(400).json({ error: 'Royalty must be between 0 and 10%' })

    let imageUri = image
    let tokenUri = ''
    if (process.env.PINATA_JWT) {
      imageUri = await pinImage(image, name.trim().replace(/[^a-zA-Z0-9-_]/g, '-'))
      tokenUri = await pinToPinata('pinJSONToIPFS', {
        pinataContent: {
          name: name.trim(),
          description,
          image: imageUri,
          attributes: [{ trait_type: 'Category', value: category.trim() }],
        },
        pinataMetadata: { name: `${name.trim()} metadata` },
      })
    }

    const now = new Date().toISOString()
    const result = db.prepare(`
      INSERT INTO assets (name, description, category, image, origin, creator, owner, royalty_bps, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)
    `).run(name.trim(), description, category.trim(), imageUri, origin, creator, creator, royaltyBps, now, now)
    const id = Number(result.lastInsertRowid)
    if (!tokenUri) tokenUri = `${process.env.PUBLIC_API_URL || `http://localhost:${port}`}/api/assets/${id}/metadata`
    db.prepare('UPDATE assets SET token_uri = ? WHERE id = ?').run(tokenUri, id)
    res.status(201).json({ id, tokenUri, storage: 'local-sqlite' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/assets/:id/mint', (req, res) => {
  const { tokenId, nftAddress, txHash, creator } = req.body
  if (!/^\d+$/.test(String(tokenId)) || !isAddress(nftAddress) || !isAddress(creator) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
    return res.status(400).json({ error: 'Invalid mint transaction details' })
  }
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND status = ?').get(req.params.id, 'Draft')
  if (!asset) return res.status(404).json({ error: 'Draft asset not found' })
  if (asset.creator.toLowerCase() !== creator.toLowerCase()) return res.status(403).json({ error: 'Only the creating wallet can confirm this mint' })
  const now = new Date().toISOString()
  const update = db.prepare('UPDATE assets SET token_id = ?, nft_address = ?, tx_hash = ?, status = ?, updated_at = ? WHERE id = ?')
  update.run(String(tokenId), nftAddress, txHash, 'Minted', now, req.params.id)
  recordTransaction(Number(req.params.id), 'Minted', txHash, creator, creator)
  res.json(mapAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)))
})

app.patch('/api/assets/:id/listing', (req, res) => {
  const { owner, priceEth, priceWei, txHash } = req.body
  if (!isAddress(owner) || typeof priceEth !== 'string' || !/^\d+(\.\d{1,18})?$/.test(priceEth) || !/^\d+$/.test(String(priceWei)) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
    return res.status(400).json({ error: 'Invalid listing details' })
  }
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND is_demo = 0').get(req.params.id)
  if (!asset || asset.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: 'This wallet does not own the asset' })
  db.prepare('UPDATE assets SET price_eth = ?, price_wei = ?, is_listed = 1, status = ?, updated_at = ? WHERE id = ?')
    .run(priceEth, String(priceWei), 'Listed', new Date().toISOString(), req.params.id)
  recordTransaction(Number(req.params.id), 'Listed', txHash, owner)
  res.json(mapAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)))
})

app.patch('/api/assets/:id/purchase', (req, res) => {
  const { buyer, txHash } = req.body
  if (!isAddress(buyer) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) return res.status(400).json({ error: 'Invalid purchase details' })
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND is_listed = 1 AND is_demo = 0').get(req.params.id)
  if (!asset) return res.status(404).json({ error: 'Active listing not found' })
  db.prepare('UPDATE assets SET owner = ?, is_listed = 0, status = ?, updated_at = ? WHERE id = ?')
    .run(buyer, 'Sold', new Date().toISOString(), req.params.id)
  recordTransaction(Number(req.params.id), 'Purchased', txHash, buyer, asset.owner, asset.price_wei)
  res.json(mapAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)))
})

app.delete('/api/assets/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND status = ?').get(req.params.id, 'Draft')
  if (!asset) return res.status(404).json({ error: 'Draft asset not found' })
  if (String(req.query.creator || '').toLowerCase() !== asset.creator.toLowerCase()) return res.status(403).json({ error: 'Only the creating wallet can remove this draft' })
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id)
  res.status(204).end()
})

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Database request failed' })
})

app.listen(port, () => console.log(`Atlas API listening on http://localhost:${port} (${databasePath})`))
