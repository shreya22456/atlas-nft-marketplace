// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AtlasNFT is ERC721URIStorage, ERC2981, Ownable {
    uint256 public nextTokenId;

    enum SupplyStatus { Manufactured, Shipped, Received, Sold }

    struct JourneyEntry {
        SupplyStatus status;
        address handler;
        uint256 timestamp;
        string location;
    }

    mapping(uint256 => JourneyEntry[]) private _journeys;

    event JourneyUpdated(uint256 indexed tokenId, SupplyStatus status, address indexed handler, uint256 timestamp);

    constructor(address initialOwner) ERC721("Atlas Authenticity", "ATLAS") Ownable(initialOwner) {
        _setDefaultRoyalty(initialOwner, 500);
    }

    function mint(address to, string calldata tokenURI, string calldata originLocation, uint96 royaltyBps) external returns (uint256) {
        require(to != address(0), "Invalid recipient");
        require(royaltyBps <= 1000, "Royalty exceeds 10%");
        uint256 tokenId = ++nextTokenId;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenURI);
        _setTokenRoyalty(tokenId, msg.sender, royaltyBps);
        _journeys[tokenId].push(JourneyEntry(SupplyStatus.Manufactured, msg.sender, block.timestamp, originLocation));
        emit JourneyUpdated(tokenId, SupplyStatus.Manufactured, msg.sender, block.timestamp);
        return tokenId;
    }

    function updateJourney(uint256 tokenId, SupplyStatus status, string calldata location) external {
        require(ownerOf(tokenId) == msg.sender, "Only current owner");
        _journeys[tokenId].push(JourneyEntry(status, msg.sender, block.timestamp, location));
        emit JourneyUpdated(tokenId, status, msg.sender, block.timestamp);
    }

    function journeyCount(uint256 tokenId) external view returns (uint256) {
        return _journeys[tokenId].length;
    }

    function journey(uint256 tokenId, uint256 index) external view returns (JourneyEntry memory) {
        require(index < _journeys[tokenId].length, "Invalid journey index");
        return _journeys[tokenId][index];
    }

    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
