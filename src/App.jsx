import { useCallback, useEffect, useState } from 'react'
import { BrowserProvider, Contract, parseEther } from 'ethers'
import { MARKETPLACE_ABI, NFT_ABI, SEPOLIA_CHAIN_ID } from './contracts'
import './App.css'

const nftAddress = import.meta.env.VITE_NFT_CONTRACT_ADDRESS
const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_CONTRACT_ADDRESS
const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const chainLabel = 'Sepolia'

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function errorMessage(error) {
  if (error?.code === 4001) return 'Transaction cancelled in MetaMask'
  return error?.reason || error?.shortMessage || error?.message || 'Something went wrong'
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `API request failed (${response.status})`)
  }
  if (response.status === 204) return null
  return response.json()
}

function App() {
  const [page, setPage] = useState('market')
  const [assets, setAssets] = useState([])
  const [selected, setSelected] = useState(null)
  const [mintOpen, setMintOpen] = useState(false)
  const [account, setAccount] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [network, setNetwork] = useState(null)

  const fetchAssets = useCallback(async (owner = '') => {
    const query = owner ? `?owner=${encodeURIComponent(owner)}` : ''
    return api(`/assets${query}`)
  }, [])
  const loadAssets = useCallback(async (owner = '') => setAssets(await fetchAssets(owner)), [fetchAssets])

  useEffect(() => {
    fetchAssets().then(setAssets).catch((error) => setNotice(`Database unavailable: ${errorMessage(error)}`))
    api('/network').then(setNetwork).catch((error) => setNotice(`Network API unavailable: ${errorMessage(error)}`))
    const ethereum = window.ethereum
    if (!ethereum) return undefined

    const reloadOnChainChange = () => window.location.reload()
    const updateAccount = (accounts) => {
      const next = accounts[0] || ''
      setAccount(next)
      if (next) loadAssets(next).catch((error) => setNotice(`Database unavailable: ${errorMessage(error)}`))
    }
    ethereum.request({ method: 'eth_accounts' })
      .then(updateAccount)
      .catch((error) => setNotice(`Wallet check failed: ${errorMessage(error)}`))
    ethereum.on('accountsChanged', updateAccount)
    ethereum.on('chainChanged', reloadOnChainChange)
    return () => {
      ethereum.removeListener('accountsChanged', updateAccount)
      ethereum.removeListener('chainChanged', reloadOnChainChange)
    }
  }, [fetchAssets, loadAssets])

  async function getSepoliaSigner() {
    if (!window.ethereum) throw new Error('MetaMask is not installed. Install MetaMask to continue.')
    const provider = new BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    const network = await provider.getNetwork()
    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0xaa36a7' }],
        })
      } catch (error) {
        if (error.code !== 4902) throw error
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0xaa36a7',
            chainName: 'Sepolia',
            nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.sepolia.org'],
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
          }],
        })
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0xaa36a7' }],
        })
      }
      throw new Error('Switched to Sepolia. Please try the transaction again.')
    }
    setAccount(await signer.getAddress())
    return signer
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setNotice('MetaMask is not installed. Install the MetaMask browser extension and try again.')
      return
    }
    setBusy(true)
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' })
      const signer = await getSepoliaSigner()
      const address = await signer.getAddress()
      await loadAssets(address)
      setNotice(`Connected to Sepolia: ${shortAddress(address)}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function openAsset(asset) {
    try {
      const detail = await api(`/assets/${asset.id}`)
      if (!detail.is_demo && detail.token_id) {
        try {
          detail.journey = await api(`/assets/${asset.id}/journey`)
        } catch (error) {
          detail.journeyError = errorMessage(error)
        }
      }
      setSelected(detail)
    } catch (error) {
      setNotice(`Could not load asset: ${errorMessage(error)}`)
    }
  }

  async function syncTransaction(path, body, owner) {
    try {
      await api(path, { method: 'PATCH', body: JSON.stringify(body) })
      await loadAssets(owner)
      const refreshed = await api(`/assets/${selected.id}`)
      try { refreshed.journey = await api(`/assets/${selected.id}/journey`) } catch (error) { refreshed.journeyError = errorMessage(error) }
      setSelected(refreshed)
    } catch (error) {
      throw new Error(`Transaction confirmed, but API sync failed: ${errorMessage(error)}`)
    }
  }

  async function updateListingPrice(asset) {
    const price = window.prompt('Enter the new sale price in Sepolia ETH')
    if (price === null) return
    setBusy(true)
    try {
      if (!marketplaceAddress) throw new Error('Set VITE_MARKETPLACE_CONTRACT_ADDRESS after deploying the marketplace.')
      const priceWei = parseEther(price.trim())
      if (priceWei <= 0n) throw new Error('Price must be greater than zero')
      const signer = await getSepoliaSigner()
      const owner = await signer.getAddress()
      const marketplace = new Contract(marketplaceAddress, MARKETPLACE_ABI, signer)
      setNotice('Confirm price update in your wallet…')
      const tx = await marketplace.updatePrice(asset.nft_address, asset.token_id, priceWei)
      await tx.wait()
      await syncTransaction(`/assets/${asset.id}/price`, {
        owner,
        priceEth: price.trim(),
        priceWei: priceWei.toString(),
        txHash: tx.hash,
      }, owner)
      setNotice('Listing price updated')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function cancelListing(asset) {
    setBusy(true)
    try {
      if (!marketplaceAddress) throw new Error('Set VITE_MARKETPLACE_CONTRACT_ADDRESS after deploying the marketplace.')
      const signer = await getSepoliaSigner()
      const owner = await signer.getAddress()
      const marketplace = new Contract(marketplaceAddress, MARKETPLACE_ABI, signer)
      setNotice('Confirm cancellation in your wallet…')
      const tx = await marketplace.cancelListing(asset.nft_address, asset.token_id)
      await tx.wait()
      await syncTransaction(`/assets/${asset.id}/cancel-listing`, { owner, txHash: tx.hash }, owner)
      setNotice('Listing cancelled')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function updateJourney(asset) {
    const labels = ['Manufactured', 'Shipped', 'Received', 'Sold']
    const currentIndex = (asset.journey || []).length
      ? labels.indexOf(asset.journey[asset.journey.length - 1].status)
      : -1
    const availableStatuses = labels.slice(Math.max(currentIndex + 1, 0))
    if (!availableStatuses.length) {
      setNotice('The product journey is already complete')
      return
    }
    const choice = window.prompt(`Choose next status: ${availableStatuses.join(', ')}`)
    if (!choice) return
    const status = labels.indexOf(choice.trim())
    if (status < 0 || !availableStatuses.includes(labels[status])) {
      setNotice(`Choose one of: ${availableStatuses.join(', ')}`)
      return
    }
    const location = window.prompt('Enter the product location')
    if (location === null) return
    setBusy(true)
    try {
      const signer = await getSepoliaSigner()
      const nft = new Contract(asset.nft_address, NFT_ABI, signer)
      setNotice('Confirm supply-chain update in your wallet…')
      const tx = await nft.updateJourney(asset.token_id, status, location)
      await tx.wait()
      const detail = await api(`/assets/${asset.id}`)
      detail.journey = await api(`/assets/${asset.id}/journey`)
      setSelected(detail)
      setNotice('Supply-chain event recorded on Sepolia')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function mintAsset(values) {
    setBusy(true)
    try {
      if (!nftAddress) throw new Error('Set VITE_NFT_CONTRACT_ADDRESS in .env.local after deploying the NFT contract.')
      const signer = await getSepoliaSigner()
      const creator = await signer.getAddress()
      const draft = await api('/assets', {
        method: 'POST',
        body: JSON.stringify({ ...values, creator }),
      })
      setNotice('Confirm mint in MetaMask…')
      const nft = new Contract(nftAddress, NFT_ABI, signer)
      const tx = await nft.mint(creator, draft.tokenUri, values.origin, values.royaltyBps)
      setNotice('Mint submitted. Waiting for Sepolia confirmation…')
      const receipt = await tx.wait()
      const transfer = receipt.logs
        .filter((log) => log.address.toLowerCase() === nftAddress.toLowerCase())
        .map((log) => {
          try { return nft.interface.parseLog(log) } catch { return null }
        })
        .find((event) => event?.name === 'Transfer' && event.args.from === '0x0000000000000000000000000000000000000000')
      if (!transfer) throw new Error(`Mint confirmed, but token ID could not be read. Transaction: ${tx.hash}`)
      try {
        await api(`/assets/${draft.id}/mint`, {
          method: 'POST',
          body: JSON.stringify({
            tokenId: transfer.args.tokenId.toString(),
            nftAddress,
            txHash: tx.hash,
            creator,
          }),
        })
      } catch (error) {
        throw new Error(`Mint confirmed (${tx.hash}), but database sync failed: ${errorMessage(error)}`)
      }
      await loadAssets(creator)
      setPage('mine')
      setMintOpen(false)
      setNotice(`NFT #${transfer.args.tokenId} minted and saved to the database`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function listAsset(asset) {
    const price = window.prompt('Enter sale price in Sepolia ETH')
    if (price === null) return
    setBusy(true)
    try {
      if (!marketplaceAddress) throw new Error('Set VITE_MARKETPLACE_CONTRACT_ADDRESS in .env.local after deploying the marketplace.')
      const priceWei = parseEther(price.trim())
      if (priceWei <= 0n) throw new Error('Price must be greater than zero')
      const signer = await getSepoliaSigner()
      const nft = new Contract(asset.nft_address || nftAddress, NFT_ABI, signer)
      const marketplace = new Contract(marketplaceAddress, MARKETPLACE_ABI, signer)
      setNotice('Approve marketplace in MetaMask…')
      const approval = await nft.approve(marketplaceAddress, asset.token_id)
      await approval.wait()
      const tx = await marketplace.list(asset.nft_address || nftAddress, asset.token_id, priceWei)
      setNotice('Listing submitted. Waiting for confirmation…')
      await tx.wait()
      const owner = await signer.getAddress()
      try {
        await api(`/assets/${asset.id}/listing`, {
          method: 'PATCH',
          body: JSON.stringify({ owner, priceEth: price.trim(), priceWei: priceWei.toString(), txHash: tx.hash }),
        })
      } catch (error) {
        throw new Error(`Listing confirmed (${tx.hash}), but database sync failed: ${errorMessage(error)}`)
      }
      await loadAssets(owner)
      setNotice('NFT listed for sale')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function buyAsset(asset) {
    if (asset.is_demo) {
      setNotice('This is a sample listing. Connect a deployed Sepolia contract to buy NFTs.')
      return
    }
    setBusy(true)
    try {
      if (!marketplaceAddress) throw new Error('Set VITE_MARKETPLACE_CONTRACT_ADDRESS in .env.local after deploying the marketplace.')
      const signer = await getSepoliaSigner()
      const marketplace = new Contract(marketplaceAddress, MARKETPLACE_ABI, signer)
      const listing = await marketplace.listings(asset.nft_address, asset.token_id)
      if (!listing.active) throw new Error('This listing is no longer active. Refresh the marketplace.')
      setNotice('Confirm purchase in MetaMask…')
      const tx = await marketplace.buy(asset.nft_address, asset.token_id, { value: listing.price })
      setNotice('Purchase submitted. Waiting for Sepolia confirmation…')
      await tx.wait()
      const buyer = await signer.getAddress()
      try {
        await api(`/assets/${asset.id}/purchase`, {
          method: 'PATCH',
          body: JSON.stringify({ buyer, txHash: tx.hash }),
        })
      } catch (error) {
        throw new Error(`Purchase confirmed (${tx.hash}), but database sync failed: ${errorMessage(error)}`)
      }
      await loadAssets()
      setSelected(null)
      setNotice('Purchase confirmed and saved to the database')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const mine = assets.filter((asset) => !asset.is_demo && asset.owner.toLowerCase() === account.toLowerCase())

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { setPage('market'); setSelected(null) }} aria-label="Go to marketplace">
          <span className="brand-mark">A</span><span>ATLAS</span>
        </button>
        <nav>
          <button className={page === 'market' ? 'active' : ''} onClick={() => { setPage('market'); setSelected(null) }}>Marketplace</button>
          <button className={page === 'mine' ? 'active' : ''} onClick={() => { setPage('mine'); setSelected(null) }}>My collection</button>
        </nav>
        <button className="wallet-button" onClick={connectWallet} disabled={busy}>
          <span className="status-dot" />{account ? shortAddress(account) : 'Connect MetaMask'}
        </button>
      </header>
      {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

      {selected ? (
        <main className="detail">
          <button className="back" onClick={() => setSelected(null)}>← Back to marketplace</button>
          <section className="detail-grid">
            <div className="detail-image-wrap"><img src={selected.image} alt={selected.name} /><span className="verified">{selected.is_demo ? 'Sample preview' : 'Sepolia asset'}</span></div>
            <div className="detail-info">
              <p className="eyebrow">{selected.category} · {selected.token_id ? `#${selected.token_id}` : 'Preview'}</p>
              <h1>{selected.name}</h1>
              <p className="creator">Created by <b>{selected.creator}</b></p>
              <div className="sale-card"><div><span>Current price</span><strong><span className="eth">◆</span> {selected.price_eth || '—'} ETH</strong></div><button onClick={() => buyAsset(selected)} disabled={busy || !selected.is_listed}>Buy now</button></div>
              <div className="attributes"><div><span>Origin</span><b>{selected.origin || 'Not recorded'}</b></div><div><span>Royalty</span><b>{(selected.royalty_bps / 100).toFixed(2)}%</b></div><div><span>Chain</span><b>{selected.is_demo ? 'Preview' : chainLabel}</b></div></div>
            </div>
          </section>
          {!selected.is_demo && account.toLowerCase() === selected.owner.toLowerCase() && (
            <section className="asset-actions">
              {!selected.is_listed && <button className="mint-button" disabled={busy} onClick={() => listAsset(selected)}>List for sale</button>}
              {selected.is_listed && <>
                <button className="mint-button" disabled={busy} onClick={() => updateListingPrice(selected)}>Update price</button>
                <button className="filter" disabled={busy} onClick={() => cancelListing(selected)}>Cancel listing</button>
              </>}
              <button className="filter" disabled={busy} onClick={() => updateJourney(selected)}>Update product journey</button>
            </section>
          )}
          <section className="provenance">
            <div className="section-heading"><div><p className="eyebrow">On-chain supply-chain record</p><h2>Product journey</h2></div><span className="live"><i /> {selected.is_demo ? 'Sample data' : 'Sepolia'}</span></div>
            {selected.journeyError && <p className="history-empty">Could not load the on-chain journey: {selected.journeyError}</p>}
            <div className="timeline">
              {(selected.journey || []).map((entry, index) => (
                <div className="timeline-item" key={`${entry.timestamp}-${index}`}>
                  <div className={`timeline-node ${index === selected.journey.length - 1 ? 'latest' : ''}`}><span>{index + 1}</span></div>
                  <div><b>{entry.status}</b><p>{entry.location || 'Location not recorded'} · {shortAddress(entry.handler)}</p></div>
                  <time>{new Date(entry.timestamp * 1000).toLocaleString()}</time>
                </div>
              ))}
              {selected.is_demo && !(selected.journey || []).length && <div className="timeline-item"><div className="timeline-node"><span>1</span></div><div><b>{selected.status}</b><p>Sample listing · not verified on-chain</p></div><time>Preview</time></div>}
              {!selected.is_demo && !selected.journeyError && !(selected.journey || []).length && <p className="history-empty">No supply-chain events are recorded yet.</p>}
            </div>
          </section>
          <section className="provenance">
            <div className="section-heading"><div><p className="eyebrow">Confirmed transactions</p><h2>Transaction history</h2></div><span className="live"><i /> {selected.is_demo ? 'Preview' : 'Sepolia'}</span></div>
            <div className="timeline">
              {(selected.transactions || []).length ? selected.transactions.map((transaction, index) => (
                <div className="timeline-item" key={transaction.tx_hash}>
                  <div className={`timeline-node ${index === selected.transactions.length - 1 ? 'latest' : ''}`}><span>{index + 1}</span></div>
                  <div><b>{transaction.type}</b><p>{shortAddress(transaction.from_address)}{transaction.to_address ? ` → ${shortAddress(transaction.to_address)}` : ''}</p></div>
                  <time>{new Date(transaction.created_at).toLocaleString()}</time>
                </div>
              )) : <p className="history-empty">No confirmed transactions have been recorded yet.</p>}
            </div>
          </section>
        </main>
      ) : (
        <main>
          {page === 'market' ? (
            <>
              <section className="hero-section">
                <div><p className="eyebrow">Authenticated physical assets</p><h1>Ownership, <em>made tangible.</em></h1><p className="hero-copy">Discover and collect authenticated real-world objects, with every owner and movement recorded on-chain.</p><button className="mint-button" onClick={() => setMintOpen(true)}>Mint an NFT <span>↗</span></button></div>
                <div className="hero-art"><img src="https://images.unsplash.com/photo-1597047084897-51e81819a499?auto=format&fit=crop&w=1000&q=90" alt="Sculptural chair" /><div className="hero-card"><span>Featured drop</span><b>Monolith Chair</b><strong>0.72 ETH</strong></div></div>
              </section>
              <section className="catalog">
                <div className="section-heading"><div><p className="eyebrow">Curated works</p><h2>Marketplace</h2></div><button className="filter">{network?.connected ? `Sepolia · Block ${network.blockNumber}` : 'Sepolia · RPC not configured'} ⌄</button></div>
                <div className="product-grid">
                  {assets.map((asset) => <article className="product-card" key={asset.id} onClick={() => openAsset(asset)}>
                    <div className="product-image"><img src={asset.image} alt={asset.name} /><span>{asset.is_demo ? 'Sample' : asset.status}</span></div>
                    <div className="product-body"><p>{asset.category}</p><h3>{asset.name}</h3><div><span>Price</span><strong>{asset.price_eth ? `◆ ${asset.price_eth} ETH` : 'Not listed'}</strong></div></div>
                  </article>)}
                  {!assets.length && <p className="history-empty">No listings yet. Mint an NFT and list it for sale from your collection.</p>}
                </div>
              </section>
            </>
          ) : (
            <section className="collection">
              <div className="section-heading"><div><p className="eyebrow">Your wallet</p><h2>My collection</h2></div><button className="mint-button" onClick={() => setMintOpen(true)}>Mint an NFT <span>↗</span></button></div>
              {account ? mine.length
                ? <div className="product-grid">{mine.map((asset) => <article className="product-card" key={asset.id} onClick={() => openAsset(asset)}><div className="product-image"><img src={asset.image} alt={asset.name} /><span>{asset.status}</span></div><div className="product-body"><p>{asset.category}</p><h3>{asset.name}</h3><div><span>{asset.is_listed ? 'Listed' : 'Owned'}</span>{!asset.is_listed && <button className="inline-action" onClick={(event) => { event.stopPropagation(); listAsset(asset) }}>List for sale</button>}</div></div></article>)}</div>
                : <div className="empty"><span>◇</span><h3>No NFTs yet</h3><p>Your minted and purchased Sepolia NFTs will appear here.</p><button className="mint-button" onClick={() => setMintOpen(true)}>Mint an NFT</button></div>
                : <div className="empty"><span>◇</span><h3>Connect MetaMask</h3><p>View your NFTs, listings, and minting history.</p><button className="wallet-button" onClick={connectWallet}>Connect wallet</button></div>}
            </section>
          )}
        </main>
      )}
      {mintOpen && <MintModal busy={busy} onClose={() => setMintOpen(false)} onMint={mintAsset} />}
    </div>
  )
}

function MintModal({ onClose, onMint, busy }) {
  const [values, setValues] = useState({ name: '', description: '', category: '', image: '', origin: '', royaltyBps: 500 })
  const [imageError, setImageError] = useState('')
  function change(event) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: name === 'royaltyBps' ? Number(value) : value }))
  }
  async function selectImage(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setImageError('Choose an image smaller than 2 MB.')
      return
    }
    try {
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('Could not read the selected image'))
        reader.readAsDataURL(file)
      })
      setValues((current) => ({ ...current, image }))
      setImageError('')
    } catch (error) {
      setImageError(errorMessage(error))
    }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal" onSubmit={(event) => { event.preventDefault(); onMint(values) }} onMouseDown={(event) => event.stopPropagation()}>
    <button className="modal-close" type="button" onClick={onClose}>×</button>
    <p className="eyebrow">New asset</p><h2>Mint an NFT</h2>
    <label className="upload"><span>{values.image ? '✓' : '＋'}</span><b>{values.image ? 'Image selected' : 'Upload asset'}</b><small>PNG, JPG, WEBP or GIF · max 2 MB</small><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={selectImage} /></label>
    {imageError && <p className="form-error">{imageError}</p>}
    <label>Asset name<input name="name" value={values.name} onChange={change} maxLength="100" required placeholder="e.g. Terra No. 8" /></label>
    <label>Description<textarea name="description" value={values.description} onChange={change} maxLength="2000" placeholder="Describe the physical asset" /></label>
    <div className="modal-row"><label>Product category<input name="category" value={values.category} onChange={change} maxLength="60" required placeholder="Collectible" /></label><label>Royalty %<input type="number" min="0" max="10" step="0.1" value={values.royaltyBps / 100} onChange={(event) => setValues((current) => ({ ...current, royaltyBps: Math.round(Number(event.target.value) * 100) }))} /></label></div>
    <label>Manufacturing origin<input name="origin" value={values.origin} onChange={change} maxLength="120" placeholder="Berlin, Germany" /></label>
    <p className="storage-note">Metadata is saved in Supabase. Configure Pinata to publish it to IPFS.</p>
    <button className="mint-submit" type="submit" disabled={busy || !values.image}>{busy ? 'Waiting for transaction…' : 'Mint on Sepolia'}</button>
  </form></div>
}

export default App
