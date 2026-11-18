import dotenv from 'dotenv'
import express from 'express'
import { Contract, Interface, JsonRpcProvider, getAddress } from 'ethers'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

const app = express()
const port = Number(process.env.PORT || process.env.API_PORT || 3001)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  : null
const nftInterface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event JourneyUpdated(uint256 indexed tokenId, uint8 status, address indexed handler, uint256 timestamp)',
])
const marketplaceInterface = new Interface([
  'event Listed(address indexed nft, uint256 indexed tokenId, address indexed seller, uint256 price)',
  'event ListingCancelled(address indexed nft, uint256 indexed tokenId)',
  'event PriceUpdated(address indexed nft, uint256 indexed tokenId, uint256 price)',
  'event Purchased(address indexed nft, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price)',
])
const journeyStatus = ['Manufactured', 'Shipped', 'Received', 'Sold']
const provider = process.env.SEPOLIA_RPC_URL
  ? new JsonRpcProvider(process.env.SEPOLIA_RPC_URL, 11155111)
  : null

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.get('origin')
  if (origin && allowedOrigins.includes(origin)) {
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

function databaseTable(name) {
  if (!supabase) {
    const error = new Error('Supabase is not configured on the API server')
    error.statusCode = 503
    throw error
  }
  return supabase.from(name)
}

async function queryData(query) {
  const { data, error } = await query
  if (error) throw new Error(`Supabase request failed: ${error.message}`)
  return data
}

async function recordTransaction(assetId, type, txHash, fromAddress, toAddress = '', amountWei = '') {
  await queryData(databaseTable('transactions').insert({
    asset_id: assetId,
    type,
    tx_hash: txHash,
    from_address: fromAddress,
    to_address: toAddress,
    amount_wei: amountWei,
    created_at: new Date().toISOString(),
  }))
}

function configuredAddress(...values) {
  const address = values.find(Boolean)
  return address && isAddress(address) ? getAddress(address) : ''
}

function requireConfiguredAddress(...values) {
  const address = configuredAddress(...values)
  if (!address) {
    const error = new Error('The required deployed contract address is not configured on the API server')
    error.statusCode = 503
    throw error
  }
  return address
}

function requireProvider() {
  if (!provider) {
    const error = new Error('SEPOLIA_RPC_URL is not configured on the API server')
    error.statusCode = 503
    throw error
  }
  return provider
}

async function confirmedEvent({ txHash, contractAddress, eventName, argsMatch, fromAddress }) {
  const chain = requireProvider()
  const [network, transaction, receipt] = await Promise.all([
    chain.getNetwork(),
    chain.getTransaction(txHash),
    chain.getTransactionReceipt(txHash),
  ])
  if (Number(network.chainId) !== 11155111) throw new Error('API RPC is not connected to Sepolia')
  if (!transaction || !receipt || receipt.status !== 1) throw new Error('Transaction is missing or not confirmed successfully')
  if (transaction.to?.toLowerCase() !== contractAddress.toLowerCase()) throw new Error('Transaction targets a different contract')
  if (fromAddress && transaction.from.toLowerCase() !== fromAddress.toLowerCase()) throw new Error('Transaction sender does not match the connected wallet')
  const iface = eventName === 'Listed' || eventName === 'ListingCancelled' || eventName === 'PriceUpdated' || eventName === 'Purchased'
    ? marketplaceInterface
    : nftInterface
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase())
    .map((log) => {
      try { return iface.parseLog(log) } catch { return null }
    })
    .find((log) => log?.name === eventName && argsMatch(log.args))
  if (!event) throw new Error(`Confirmed transaction does not contain the expected ${eventName} event`)
  return { transaction, receipt, event }
}

app.get('/api/health', async (_req, res) => {
  try {
    await queryData(databaseTable('assets').select('id').limit(1))
    res.json({ ok: true, database: 'supabase' })
  } catch (error) {
    res.status(error.statusCode || 503).json({ ok: false, database: 'supabase', error: error.message })
  }
})

app.get('/api/network', async (_req, res, next) => {
  try {
    const nft = configuredAddress(process.env.NFT_CONTRACT_ADDRESS, process.env.VITE_NFT_CONTRACT_ADDRESS)
    const marketplace = configuredAddress(process.env.MARKETPLACE_CONTRACT_ADDRESS, process.env.VITE_MARKETPLACE_CONTRACT_ADDRESS)
    if (!provider) {
      return res.json({ chainId: 11155111, name: 'Sepolia', connected: false, nftAddress: nft || null, marketplaceAddress: marketplace || null })
    }
    const [network, blockNumber, nftCode, marketplaceCode] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      nft ? provider.getCode(nft) : '0x',
      marketplace ? provider.getCode(marketplace) : '0x',
    ])
    if (Number(network.chainId) !== 11155111) throw new Error('API RPC is not connected to Sepolia')
    res.json({
      chainId: Number(network.chainId),
      name: 'Sepolia',
      connected: true,
      blockNumber,
      nftAddress: nft || null,
      nftDeployed: Boolean(nft && nftCode !== '0x'),
      marketplaceAddress: marketplace || null,
      marketplaceDeployed: Boolean(marketplace && marketplaceCode !== '0x'),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/assets', async (req, res, next) => {
  try {
    const owner = typeof req.query.owner === 'string' ? req.query.owner.toLowerCase() : ''
    if (owner && !isAddress(owner)) return res.status(400).json({ error: 'Invalid owner address' })
    const query = owner
      ? databaseTable('assets').select('*').ilike('owner', owner).eq('is_demo', false).order('id', { ascending: false })
      : databaseTable('assets').select('*').eq('is_listed', true)
        .order('is_demo', { ascending: false }).order('id', { ascending: false })
    res.json((await queryData(query)).map(mapAsset))
  } catch (error) {
    next(error)
  }
})

app.get('/api/assets/:id', async (req, res, next) => {
  try {
    const row = await queryData(databaseTable('assets').select('*').eq('id', req.params.id).maybeSingle())
    const asset = mapAsset(row)
    if (!asset) return res.status(404).json({ error: 'Asset not found' })
    const transactions = await queryData(databaseTable('transactions')
      .select('type, tx_hash, from_address, to_address, amount_wei, created_at')
      .eq('asset_id', req.params.id).order('id', { ascending: true }))
    res.json({ ...asset, transactions })
  } catch (error) {
    next(error)
  }
})

app.get('/api/assets/:id/metadata', async (req, res, next) => {
  try {
    const asset = await queryData(databaseTable('assets').select('name, description, image, category')
      .eq('id', req.params.id).maybeSingle())
    if (!asset) return res.status(404).json({ error: 'Metadata not found' })
    res.json({
      name: asset.name,
      description: asset.description,
      image: asset.image,
      attributes: [{ trait_type: 'Category', value: asset.category }],
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/assets/:id/journey', async (req, res, next) => {
  try {
    const asset = await queryData(databaseTable('assets').select('*')
      .eq('id', req.params.id).eq('is_demo', false).maybeSingle())
    if (!asset || !asset.nft_address || !asset.token_id) return res.status(404).json({ error: 'Minted on-chain asset not found' })
    const chain = requireProvider()
    const network = await chain.getNetwork()
    if (Number(network.chainId) !== 11155111) throw new Error('API RPC is not connected to Sepolia')
    const nft = new Contract(asset.nft_address, [
      'function journeyCount(uint256 tokenId) view returns (uint256)',
      'function journey(uint256 tokenId, uint256 index) view returns (uint8 status, address handler, uint256 timestamp, string location)',
    ], chain)
    const count = Number(await nft.journeyCount(asset.token_id))
    const entries = await Promise.all(Array.from({ length: count }, (_, index) => nft.journey(asset.token_id, index)))
    res.json(entries.map((entry, index) => ({
      index,
      status: journeyStatus[Number(entry.status)] || 'Unknown',
      handler: entry.handler,
      timestamp: Number(entry.timestamp),
      location: entry.location,
    })))
  } catch (error) {
    next(error)
  }
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
    const draft = await queryData(databaseTable('assets').insert({
      name: name.trim(),
      description,
      category: category.trim(),
      image: imageUri,
      origin,
      creator,
      owner: creator,
      royalty_bps: royaltyBps,
      status: 'Draft',
      created_at: now,
      updated_at: now,
    }).select('id').single())
    const id = draft.id
    const publicApiUrl = process.env.PUBLIC_API_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`)
    if (!tokenUri) tokenUri = `${publicApiUrl.replace(/\/$/, '')}/api/assets/${id}/metadata`
    await queryData(databaseTable('assets').update({ token_uri: tokenUri }).eq('id', id))
    res.status(201).json({ id, tokenUri, storage: 'supabase' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/assets/:id/mint', async (req, res, next) => {
  try {
  const { tokenId, nftAddress, txHash, creator } = req.body
  if (!/^\d+$/.test(String(tokenId)) || !isAddress(nftAddress) || !isAddress(creator) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
    return res.status(400).json({ error: 'Invalid mint transaction details' })
  }
  const asset = await queryData(databaseTable('assets').select('*')
    .eq('id', req.params.id).eq('status', 'Draft').maybeSingle())
  if (!asset) return res.status(404).json({ error: 'Draft asset not found' })
  if (asset.creator.toLowerCase() !== creator.toLowerCase()) return res.status(403).json({ error: 'Only the creating wallet can confirm this mint' })
  const configuredNft = requireConfiguredAddress(process.env.NFT_CONTRACT_ADDRESS, process.env.VITE_NFT_CONTRACT_ADDRESS)
  if (getAddress(nftAddress) !== configuredNft) return res.status(400).json({ error: 'NFT contract does not match the configured Sepolia contract' })
  await confirmedEvent({
    txHash,
    contractAddress: getAddress(nftAddress),
    eventName: 'Transfer',
    fromAddress: creator,
    argsMatch: (args) => args.from === '0x0000000000000000000000000000000000000000'
      && args.to.toLowerCase() === creator.toLowerCase()
      && args.tokenId.toString() === String(tokenId),
  })
  const now = new Date().toISOString()
  const updated = await queryData(databaseTable('assets').update({
    token_id: String(tokenId),
    nft_address: nftAddress,
    tx_hash: txHash,
    status: 'Minted',
    updated_at: now,
  }).eq('id', req.params.id).select('*').single())
  await recordTransaction(req.params.id, 'Minted', txHash, creator, creator)
  res.json(mapAsset(updated))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/assets/:id/listing', async (req, res, next) => {
  try {
  const { owner, priceEth, priceWei, txHash } = req.body
  if (!isAddress(owner) || typeof priceEth !== 'string' || !/^\d+(\.\d{1,18})?$/.test(priceEth) || !/^\d+$/.test(String(priceWei)) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
    return res.status(400).json({ error: 'Invalid listing details' })
  }
  const asset = await queryData(databaseTable('assets').select('*')
    .eq('id', req.params.id).eq('is_demo', false).maybeSingle())
  if (!asset || asset.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: 'This wallet does not own the asset' })
  if (!asset.nft_address || !asset.token_id) return res.status(409).json({ error: 'Asset has not been minted on-chain' })
  await confirmedEvent({
    txHash,
    contractAddress: requireConfiguredAddress(process.env.MARKETPLACE_CONTRACT_ADDRESS, process.env.VITE_MARKETPLACE_CONTRACT_ADDRESS),
    eventName: 'Listed',
    fromAddress: owner,
    argsMatch: (args) => args.nft.toLowerCase() === asset.nft_address.toLowerCase()
      && args.tokenId.toString() === asset.token_id
      && args.seller.toLowerCase() === owner.toLowerCase()
      && args.price.toString() === String(priceWei),
  })
  const updated = await queryData(databaseTable('assets').update({
    price_eth: priceEth,
    price_wei: String(priceWei),
    is_listed: true,
    status: 'Listed',
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select('*').single())
  await recordTransaction(req.params.id, 'Listed', txHash, owner)
  res.json(mapAsset(updated))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/assets/:id/purchase', async (req, res, next) => {
  try {
  const { buyer, txHash } = req.body
  if (!isAddress(buyer) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) return res.status(400).json({ error: 'Invalid purchase details' })
  const asset = await queryData(databaseTable('assets').select('*')
    .eq('id', req.params.id).eq('is_listed', true).eq('is_demo', false).maybeSingle())
  if (!asset) return res.status(404).json({ error: 'Active listing not found' })
  if (!asset.nft_address || !asset.token_id || !asset.price_wei) return res.status(409).json({ error: 'Listing is missing on-chain details' })
  await confirmedEvent({
    txHash,
    contractAddress: requireConfiguredAddress(process.env.MARKETPLACE_CONTRACT_ADDRESS, process.env.VITE_MARKETPLACE_CONTRACT_ADDRESS),
    eventName: 'Purchased',
    fromAddress: buyer,
    argsMatch: (args) => args.nft.toLowerCase() === asset.nft_address.toLowerCase()
      && args.tokenId.toString() === asset.token_id
      && args.buyer.toLowerCase() === buyer.toLowerCase()
      && args.seller.toLowerCase() === asset.owner.toLowerCase()
      && args.price.toString() === asset.price_wei,
  })
  const updated = await queryData(databaseTable('assets').update({
    owner: buyer,
    is_listed: false,
    status: 'Sold',
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select('*').single())
  await recordTransaction(req.params.id, 'Purchased', txHash, buyer, asset.owner, asset.price_wei)
  res.json(mapAsset(updated))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/assets/:id/cancel-listing', async (req, res, next) => {
  try {
    const { owner, txHash } = req.body
    if (!isAddress(owner) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) return res.status(400).json({ error: 'Invalid cancellation details' })
    const asset = await queryData(databaseTable('assets').select('*')
      .eq('id', req.params.id).eq('is_listed', true).eq('is_demo', false).maybeSingle())
    if (!asset || asset.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: 'This wallet does not own the active listing' })
    await confirmedEvent({
      txHash,
      contractAddress: requireConfiguredAddress(process.env.MARKETPLACE_CONTRACT_ADDRESS, process.env.VITE_MARKETPLACE_CONTRACT_ADDRESS),
      eventName: 'ListingCancelled',
      fromAddress: owner,
      argsMatch: (args) => args.nft.toLowerCase() === asset.nft_address.toLowerCase()
        && args.tokenId.toString() === asset.token_id,
    })
    const updated = await queryData(databaseTable('assets').update({
      is_listed: false,
      status: 'Minted',
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select('*').single())
    await recordTransaction(req.params.id, 'Listing cancelled', txHash, owner)
    res.json(mapAsset(updated))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/assets/:id/price', async (req, res, next) => {
  try {
    const { owner, priceEth, priceWei, txHash } = req.body
    if (!isAddress(owner) || typeof priceEth !== 'string' || !/^\d+(\.\d{1,18})?$/.test(priceEth)
      || !/^\d+$/.test(String(priceWei)) || !/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
      return res.status(400).json({ error: 'Invalid price update details' })
    }
    const asset = await queryData(databaseTable('assets').select('*')
      .eq('id', req.params.id).eq('is_listed', true).eq('is_demo', false).maybeSingle())
    if (!asset || asset.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: 'This wallet does not own the active listing' })
    await confirmedEvent({
      txHash,
      contractAddress: requireConfiguredAddress(process.env.MARKETPLACE_CONTRACT_ADDRESS, process.env.VITE_MARKETPLACE_CONTRACT_ADDRESS),
      eventName: 'PriceUpdated',
      fromAddress: owner,
      argsMatch: (args) => args.nft.toLowerCase() === asset.nft_address.toLowerCase()
        && args.tokenId.toString() === asset.token_id
        && args.price.toString() === String(priceWei),
    })
    const updated = await queryData(databaseTable('assets').update({
      price_eth: priceEth,
      price_wei: String(priceWei),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select('*').single())
    await recordTransaction(req.params.id, 'Price updated', txHash, owner)
    res.json(mapAsset(updated))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/assets/:id', async (req, res, next) => {
  try {
    const asset = await queryData(databaseTable('assets').select('*')
      .eq('id', req.params.id).eq('status', 'Draft').maybeSingle())
    if (!asset) return res.status(404).json({ error: 'Draft asset not found' })
    if (String(req.query.creator || '').toLowerCase() !== asset.creator.toLowerCase()) {
      return res.status(403).json({ error: 'Only the creating wallet can remove this draft' })
    }
    await queryData(databaseTable('assets').delete().eq('id', req.params.id))
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Database request failed' })
})

if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`Atlas API listening on http://localhost:${port}`))
}

export default app
