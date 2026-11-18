export const NFT_ABI = [
  'function mint(address to, string tokenURI, string originLocation, uint96 royaltyBps)',
  'function approve(address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function nextTokenId() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]

export const MARKETPLACE_ABI = [
  'function listings(address nft, uint256 tokenId) view returns (address seller, uint256 price, bool active)',
  'function list(address nft, uint256 tokenId, uint256 price)',
  'function buy(address nft, uint256 tokenId) payable',
]

export const SEPOLIA_CHAIN_ID = 11155111
