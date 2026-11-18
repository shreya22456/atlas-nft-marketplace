// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract MockZeroReceiverRoyaltyNFT is ERC721, IERC2981 {
    constructor(address initialOwner) ERC721("Invalid Royalty", "BAD") {
        _safeMint(initialOwner, 1);
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external
        pure
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        return (address(0), salePrice / 10);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }
}

contract MockPlainNFT is ERC721 {
    constructor(address initialOwner) ERC721("No Royalties", "PLAIN") {
        _safeMint(initialOwner, 1);
    }
}
