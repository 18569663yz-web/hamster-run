// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title ScoreLedger — 《仓鼠快跑》每日冠军成绩存证（Sepolia 测试网）
/// 规则（方案 v0.2 §6④ / §7.2）：后端把每日冠军成绩写入时，一并写入当时
/// Squeekchain 的块高（成绩出生证明）。写入须带 REPORTER 签名（owner 本人可直写）；
/// 同一天以 payloadHash 去重，squeekBlock 只能单调不减；guardian 只能紧急暂停。
contract ScoreLedger is Ownable {
    struct Champion {
        address player;
        uint64 score;
        uint32 distance;
        uint16 hamster;
        uint64 squeekBlock;
        bytes32 payloadHash;
    }

    mapping(uint32 => Champion) public champions; // dayId -> 冠军
    address public reporter;
    address public guardian;
    bool public paused;

    event ChampionSubmitted(uint32 indexed dayId, address indexed player, uint64 score, uint64 squeekBlock);
    event ReporterSet(address reporter);
    event GuardianSet(address guardian);
    event PauseSet(bool paused);

    constructor(address initialReporter, address initialGuardian) Ownable(msg.sender) {
        reporter = initialReporter;
        guardian = initialGuardian;
    }

    function setReporter(address newReporter) external onlyOwner {
        reporter = newReporter;
        emit ReporterSet(newReporter);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    function setPaused(bool p) external {
        require(msg.sender == owner() || msg.sender == guardian, "not owner/guardian");
        // guardian 只能暂停，不能解暂停
        require(p == true || msg.sender == owner(), "guardian can only pause");
        paused = p;
        emit PauseSet(p);
    }

    function submitChampion(uint32 dayId, Champion calldata c, bytes calldata sig) external {
        require(!paused, "paused");
        if (msg.sender != owner()) {
            bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
                keccak256(abi.encode(dayId, c.player, c.score, c.distance, c.hamster, c.squeekBlock, c.payloadHash))
            );
            require(ECDSA.recover(digest, sig) == reporter, "bad reporter signature");
        }
        Champion storage cur = champions[dayId];
        require(c.payloadHash != cur.payloadHash, "duplicate payload");
        require(c.squeekBlock >= cur.squeekBlock, "squeekBlock not monotonic");
        champions[dayId] = c;
        emit ChampionSubmitted(dayId, c.player, c.score, c.squeekBlock);
    }

    function getChampion(uint32 dayId) external view returns (Champion memory) {
        return champions[dayId];
    }
}
