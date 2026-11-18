// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";

contract AtlasMarketplace is ReentrancyGuard {
    struct Listing {
        uint256 price;
        address seller;
        bool active;
    }

    address public immutable owner;
    uint256 public marketplaceFeeBps = 250;
    mapping(address => mapping(uint256 => Listing)) public listings;

    event Listed(address indexed nft, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ListingCancelled(address indexed nft, uint256 indexed tokenId);
    event PriceUpdated(address indexed nft, uint256 indexed tokenId, uint256 price);
    event Purchased(address indexed nft, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price);

    constructor() { owner = msg.sender; }

    function list(address nft, uint256 tokenId, uint256 price) external {
        require(price > 0, "Price must exceed zero");
        require(IERC721(nft).ownerOf(tokenId) == msg.sender, "Not token owner");
        require(IERC721(nft).isApprovedForAll(msg.sender, address(this)) || IERC721(nft).getApproved(tokenId) == address(this), "Marketplace not approved");
        listings[nft][tokenId] = Listing(price, msg.sender, true);
        emit Listed(nft, tokenId, msg.sender, price);
    }

    function cancelListing(address nft, uint256 tokenId) external {
        Listing storage listing = listings[nft][tokenId];
        require(listing.active && listing.seller == msg.sender, "No active listing");
        listings[nft][tokenId].active = false;
        emit ListingCancelled(nft, tokenId);
    }

    function updatePrice(address nft, uint256 tokenId, uint256 price) external {
        Listing storage listing = listings[nft][tokenId];
        require(listing.active && listing.seller == msg.sender, "No active listing");
        require(price > 0, "Price must exceed zero");
        listing.price = price;
        emit PriceUpdated(nft, tokenId, price);
    }

    function buy(address nft, uint256 tokenId) external payable nonReentrant {
        Listing storage listing = listings[nft][tokenId];
        require(listing.active, "Listing not active");
        require(msg.value == listing.price, "Incorrect ETH amount");
        address seller = listing.seller;
        listing.active = false;

        uint256 fee = (msg.value * marketplaceFeeBps) / 10000;
        uint256 royalty;
        address royaltyReceiver;
        try IERC2981(nft).royaltyInfo(tokenId, msg.value) returns (address receiver, uint256 amount) {
            royaltyReceiver = receiver;
            royalty = amount;
        } catch {
            royalty = 0;
        }
        require(royalty == 0 || royaltyReceiver != address(0), "Invalid royalty receiver");
        if (royalty > msg.value) royalty = msg.value;
        require(royalty + fee <= msg.value, "Fees exceed price");

        IERC721(nft).safeTransferFrom(seller, msg.sender, tokenId);
        if (royaltyReceiver != address(0) && royalty > 0) {
            (bool paidRoyalty,) = payable(royaltyReceiver).call{value: royalty}("");
            require(paidRoyalty, "Royalty payment failed");
        }
        if (fee > 0) {
            (bool paidFee,) = payable(owner).call{value: fee}("");
            require(paidFee, "Fee payment failed");
        }
        (bool paidSeller,) = payable(seller).call{value: msg.value - royalty - fee}("");
        require(paidSeller, "Seller payment failed");
        emit Purchased(nft, tokenId, msg.sender, seller, msg.value);
    }

    function setMarketplaceFee(uint256 feeBps) external {
        require(msg.sender == owner, "Only owner");
        require(feeBps <= 1000, "Fee too high");
        marketplaceFeeBps = feeBps;
    }
}
