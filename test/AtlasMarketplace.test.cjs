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

  it("records supply-chain updates from the current token owner", async function () {
    const [creator, nextOwner, stranger] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(creator.address);
    await nft.waitForDeployment();

    await nft.connect(creator).mint(creator.address, "ipfs://asset", "Berlin", 500);
    await nft.connect(creator).updateJourney(1, 1, "Hamburg");
    await nft.connect(creator).transferFrom(creator.address, nextOwner.address, 1);
    await nft.connect(nextOwner).updateJourney(1, 2, "London");

    expect(await nft.journeyCount(1)).to.equal(3);
    const lastEntry = await nft.journey(1, 2);
    expect(lastEntry.status).to.equal(2);
    expect(lastEntry.handler).to.equal(nextOwner.address);
    expect(lastEntry.location).to.equal("London");
    await expect(nft.connect(stranger).updateJourney(1, 3, "Paris"))
      .to.be.revertedWith("Only current owner");
  });

  it("allows the seller to update or cancel a listing", async function () {
    const [owner, seller] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).mint(seller.address, "ipfs://asset", "Berlin", 500);
    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    await marketplace.connect(seller).updatePrice(await nft.getAddress(), 1, ethers.parseEther("2"));

    let listing = await marketplace.listings(await nft.getAddress(), 1);
    expect(listing.price).to.equal(ethers.parseEther("2"));
    await marketplace.connect(seller).cancelListing(await nft.getAddress(), 1);
    listing = await marketplace.listings(await nft.getAddress(), 1);
    expect(listing.active).to.equal(false);
  });
});
