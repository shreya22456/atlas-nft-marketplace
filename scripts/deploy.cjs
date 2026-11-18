const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const NFT = await hre.ethers.getContractFactory("AtlasNFT");
  const nft = await NFT.deploy(deployer.address);
  await nft.waitForDeployment();
  const Marketplace = await hre.ethers.getContractFactory("AtlasMarketplace");
  const marketplace = await Marketplace.deploy();
  await marketplace.waitForDeployment();
  console.log("AtlasNFT:", await nft.getAddress());
  console.log("AtlasMarketplace:", await marketplace.getAddress());
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
