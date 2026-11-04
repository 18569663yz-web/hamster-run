// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title HamsterNFT v2 — 《仓鼠快跑》角色 NFT（Sepolia 测试网）
/// 规则（2026-11-02 项目方改版）：
/// - 开局只有基础仓鼠（物种 1）可 mint；其余物种按顺序解锁：mint 物种 n>1 前必须已持有物种 n-1（合约强制）。
/// - 解锁里程（账号总 km：2000/5000/10000/20000）与升级里程（本鼠累计 km：升 Lv2/3/4/5 需 1000/3000/5000/8000）
///   由服务端核验后签名放行，合约验签。
/// - 每次 mint 收费 0.01 Sepolia ETH（防女巫），费用在 mint 交易内直接转入 feeRecipient（部署钱包）。
/// - 等级 = 该地址对该物种的累计 mint 次数，Lv5 封顶。
contract HamsterNFTv2 is ERC721, Ownable {
    using Strings for uint256;

    uint8 public constant MAX_LEVEL = 5;

    bool public mintOpen;
    address public serverSigner;
    address public feeRecipient;
    uint256 public mintPrice = 0.01 ether;

    uint256 private _nextId;
    mapping(uint256 => uint8) public speciesOf;
    mapping(uint256 => uint8) public levelOfToken;
    mapping(address => mapping(uint8 => uint8)) public speciesMintCount;
    mapping(address => uint256) public mintNonce;

    event Minted(address indexed player, uint256 indexed tokenId, uint8 species, uint8 level, uint256 fee);
    event MintOpenSet(bool open);
    event ServerSignerSet(address signer);
    event FeeRecipientSet(address recipient);
    event MintPriceSet(uint256 price);

    constructor(address initialServerSigner, address initialFeeRecipient)
        ERC721("Hamster Run", "HAMSTER")
        Ownable(msg.sender)
    {
        serverSigner = initialServerSigner;
        feeRecipient = initialFeeRecipient;
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setServerSigner(address signer) external onlyOwner {
        serverSigner = signer;
        emit ServerSignerSet(signer);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function setMintPrice(uint256 price) external onlyOwner {
        mintPrice = price;
        emit MintPriceSet(price);
    }

    /// @notice 玩家当前某物种的有效等级（0 = 未持有）
    function speciesLevel(address player, uint8 species) external view returns (uint8) {
        return speciesMintCount[player][species];
    }

    /// @param species 1..5（栗子/雪球/煤球/花生/芝麻，按顺序解锁）
    /// @param deadline 服务端签名有效期（unix 秒）
    /// @param serverSig 服务端对 (player, species, deadline, nonce) 的签名（服务端已核验里程资格）
    function mint(uint8 species, uint256 deadline, bytes calldata serverSig) external payable returns (uint256 tokenId) {
        require(mintOpen, "mint not open");
        require(species >= 1 && species <= 5, "bad species");
        require(msg.value == mintPrice, "fee must be 0.01 Sepolia ETH");
        require(block.timestamp <= deadline, "signature expired");
        if (species > 1) {
            require(speciesMintCount[msg.sender][species - 1] >= 1, "previous hamster not unlocked");
        }

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(msg.sender, species, deadline, mintNonce[msg.sender]))
        );
        require(ECDSA.recover(digest, serverSig) == serverSigner, "bad server signature");

        uint8 count = speciesMintCount[msg.sender][species] + 1;
        require(count <= MAX_LEVEL, "species max level");

        mintNonce[msg.sender] += 1;
        speciesMintCount[msg.sender][species] = count;

        // 费用直接转入部署钱包
        (bool ok, ) = payable(feeRecipient).call{value: msg.value}("");
        require(ok, "fee transfer failed");

        tokenId = ++_nextId;
        speciesOf[tokenId] = species;
        levelOfToken[tokenId] = count;
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, species, count, msg.value);
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
