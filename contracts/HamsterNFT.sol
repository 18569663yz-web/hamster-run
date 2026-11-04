// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title HamsterNFT — 《仓鼠快跑》角色 NFT（Sepolia 测试网）
/// 规则（方案 v0.2 §5.2 / §7.1）：五只仓鼠全部 mint 获得，mint 免费（0 价）；
/// 首次 mint 由服务端签名下发“随机 3 选 1”的结果，合约验签后才发；
/// 重复 mint 同一只自动升级（等级 = 该地址对该物种的累计 mint 次数，Lv5 封顶）；
/// 单地址每 24 小时最多 mint 1 次。
contract HamsterNFT is ERC721, Ownable {
    using Strings for uint256;

    uint8 public constant MAX_LEVEL = 5;

    bool public mintOpen;
    address public serverSigner;

    uint256 private _nextId;
    mapping(uint256 => uint8) public speciesOf;   // tokenId -> 物种 1..5
    mapping(uint256 => uint8) public levelOfToken; // tokenId -> 等级 1..5
    mapping(address => mapping(uint8 => uint8)) public speciesMintCount; // 地址 -> 物种 -> 累计 mint 次数
    mapping(address => uint64) public lastMintAt;
    mapping(address => uint256) public mintNonce;

    event Minted(address indexed player, uint256 indexed tokenId, uint8 species, uint8 level);
    event MintOpenSet(bool open);
    event ServerSignerSet(address signer);

    constructor(address initialServerSigner) ERC721("Hamster Run", "HAMSTER") Ownable(msg.sender) {
        serverSigner = initialServerSigner;
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setServerSigner(address signer) external onlyOwner {
        serverSigner = signer;
        emit ServerSignerSet(signer);
    }

    /// @notice 玩家当前某物种的有效等级（0 = 未持有）
    function speciesLevel(address player, uint8 species) external view returns (uint8) {
        return speciesMintCount[player][species];
    }

    /// @param species 1..5（栗子/雪球/煤球/花生/芝麻）
    /// @param deadline 服务端签名有效期（unix 秒）
    /// @param serverSig 服务端对 (player, species, deadline, nonce) 的签名
    function mint(uint8 species, uint256 deadline, bytes calldata serverSig) external returns (uint256 tokenId) {
        require(mintOpen, "mint not open");
        require(species >= 1 && species <= 5, "bad species");
        require(block.timestamp <= deadline, "signature expired");
        require(uint256(lastMintAt[msg.sender]) + 1 days <= block.timestamp, "mint cooldown 24h");

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(msg.sender, species, deadline, mintNonce[msg.sender]))
        );
        require(ECDSA.recover(digest, serverSig) == serverSigner, "bad server signature");

        uint8 count = speciesMintCount[msg.sender][species] + 1;
        require(count <= MAX_LEVEL, "species max level");

        mintNonce[msg.sender] += 1;
        lastMintAt[msg.sender] = uint64(block.timestamp);
        speciesMintCount[msg.sender][species] = count;

        tokenId = ++_nextId;
        speciesOf[tokenId] = species;
        levelOfToken[tokenId] = count;
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, species, count);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory json = string(
            abi.encodePacked(
                '{"name":"Hamster #', tokenId.toString(),
                '","description":"Hamster Run character","attributes":[',
                '{"trait_type":"species","value":', uint256(speciesOf[tokenId]).toString(), '},',
                '{"trait_type":"level","value":', uint256(levelOfToken[tokenId]).toString(), "}]}"
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }
}
