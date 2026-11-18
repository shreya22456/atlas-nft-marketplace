const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(`Expected Sepolia (11155111), connected to chain ${network.chainId}`);
  }
  const [deployer] = await hre.ethers.getSigners();
  const NFT = await hre.ethers.getContractFactory("AtlasNFT");
  const nft = await NFT.deploy(deployer.address);
  await nft.waitForDeployment();
  const Marketplace = await hre.ethers.getContractFactory("AtlasMarketplace");
  const marketplace = await Marketplace.deploy();
  await marketplace.waitForDeployment();
  const nftAddress = await nft.getAddress();
  const marketplaceAddress = await marketplace.getAddress();
  console.log("Sepolia deployment complete:");
  console.log(`VITE_NFT_CONTRACT_ADDRESS=${nftAddress}`);
  console.log(`NFT_CONTRACT_ADDRESS=${nftAddress}`);
  console.log(`VITE_MARKETPLACE_CONTRACT_ADDRESS=${marketplaceAddress}`);
  console.log(`MARKETPLACE_CONTRACT_ADDRESS=${marketplaceAddress}`);
  console.log(`https://sepolia.etherscan.io/address/${nftAddress}`);
  console.log(`https://sepolia.etherscan.io/address/${marketplaceAddress}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
