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

  it("rejects unauthorized and invalid marketplace actions", async function () {
    const [owner, seller, buyer, stranger] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).mint(seller.address, "ipfs://asset", "Berlin", 500);
    await expect(marketplace.connect(stranger).list(await nft.getAddress(), 1, 1))
      .to.be.revertedWith("Not token owner");
    await expect(marketplace.connect(seller).list(await nft.getAddress(), 1, 0))
      .to.be.revertedWith("Price must exceed zero");

    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    await expect(marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("0.9") }))
      .to.be.revertedWith("Incorrect ETH amount");
    await marketplace.connect(seller).cancelListing(await nft.getAddress(), 1);
    await expect(marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("1") }))
      .to.be.revertedWith("Listing not active");
  });

  it("splits a sale between creator, seller, and marketplace owner", async function () {
    const [owner, creator, seller, buyer] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();
    const price = ethers.parseEther("1");

    await nft.connect(creator).mint(seller.address, "ipfs://asset", "Berlin", 500);
    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, price);
    const balancesBefore = await Promise.all([
      ethers.provider.getBalance(owner.address),
      ethers.provider.getBalance(creator.address),
      ethers.provider.getBalance(seller.address),
    ]);

    await marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: price });

    expect(await ethers.provider.getBalance(owner.address) - balancesBefore[0]).to.equal(ethers.parseEther("0.025"));
    expect(await ethers.provider.getBalance(creator.address) - balancesBefore[1]).to.equal(ethers.parseEther("0.05"));
    expect(await ethers.provider.getBalance(seller.address) - balancesBefore[2]).to.equal(ethers.parseEther("0.925"));
  });

  it("restricts marketplace fee changes to the owner and caps the fee", async function () {
    const [owner, stranger] = await ethers.getSigners();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await expect(marketplace.connect(stranger).setMarketplaceFee(300))
      .to.be.revertedWith("Only owner");
    await expect(marketplace.connect(owner).setMarketplaceFee(1001))
      .to.be.revertedWith("Fee too high");
    await marketplace.connect(owner).setMarketplaceFee(1000);
    expect(await marketplace.marketplaceFeeBps()).to.equal(1000);
  });

  it("rejects invalid mint recipients and royalties above ten percent", async function () {
    const [owner, creator] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();

    await expect(nft.connect(creator).mint(ethers.ZeroAddress, "ipfs://asset", "Berlin", 500))
      .to.be.revertedWith("Invalid recipient");
    await expect(nft.connect(creator).mint(creator.address, "ipfs://asset", "Berlin", 1001))
      .to.be.revertedWith("Royalty exceeds 10%");
  });

  it("rejects a positive royalty with a zero receiver without selling the NFT", async function () {
    const [seller, buyer] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("MockZeroReceiverRoyaltyNFT");
    const nft = await NFT.deploy(seller.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    await expect(marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("1") }))
      .to.be.revertedWith("Invalid royalty receiver");

    expect(await nft.ownerOf(1)).to.equal(seller.address);
    const listing = await marketplace.listings(await nft.getAddress(), 1);
    expect(listing.active).to.equal(true);
  });

  it("sells ERC-721 collections without ERC-2981 royalties", async function () {
    const [seller, buyer] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("MockPlainNFT");
    const nft = await NFT.deploy(seller.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    await marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("1") });

    expect(await nft.ownerOf(1)).to.equal(buyer.address);
  });

  it("keeps optimized list and buy transactions within gas budgets", async function () {
    const [owner, seller, buyer] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("AtlasNFT");
    const nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("AtlasMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    await nft.connect(seller).mint(seller.address, "ipfs://gas", "Berlin", 500);
    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    const listingTx = await marketplace.connect(seller).list(await nft.getAddress(), 1, ethers.parseEther("1"));
    const listingReceipt = await listingTx.wait();
    expect(listingReceipt.gasUsed).to.be.lessThan(90000n);

    const purchaseTx = await marketplace.connect(buyer).buy(await nft.getAddress(), 1, { value: ethers.parseEther("1") });
    const purchaseReceipt = await purchaseTx.wait();
    expect(purchaseReceipt.gasUsed).to.be.lessThan(110000n);
  });
});
