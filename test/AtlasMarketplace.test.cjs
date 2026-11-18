const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Atlas marketplace", function () {
  it("mints, lists, and sells an NFT", async function () {
    const [owner, seller, buyer] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).mint(seller.address, "ipfs://asset", "Berlin", 500);
    const [royaltyReceiver, royaltyAmount] = await nft.royaltyInfo(1, ethers.parseEther("1"));
    expect(royaltyReceiver).to.equal(seller.address);
    expect(royaltyAmount).to.equal(ethers.parseEther("0.05"));
    await nft.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    await marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("1") });

    expect(await nft.ownerOf(1)).to.equal(buyer.address);
  });
});
