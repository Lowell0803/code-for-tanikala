// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    mapping(bytes32 => bool) public isRegistered;
    mapping(bytes32 => uint256) public candidateVotes;
    bytes32[] public candidateList;

    event CandidateRegistered(bytes32 candidateId);
    event VoteCasted(bytes32 candidateId, uint256 newVoteCount);

    function registerCandidates(bytes32[] calldata candidateIds) external {
        for (uint256 i = 0; i < candidateIds.length; ) {
            bytes32 candidateId = candidateIds[i];
            if (!isRegistered[candidateId]) {
                isRegistered[candidateId] = true;
                candidateVotes[candidateId] = 0;
                candidateList.push(candidateId);
                emit CandidateRegistered(candidateId);
            }
            unchecked { i++; }
        }
    }

    function voteForCandidates(bytes32[] calldata candidateIds) external {
        for (uint256 i = 0; i < candidateIds.length; ) {
            bytes32 candidateId = candidateIds[i];
            require(isRegistered[candidateId], "Candidate not registered");
            candidateVotes[candidateId]++;
            emit VoteCasted(candidateId, candidateVotes[candidateId]);
            unchecked { i++; }
        }
    }

    function getCandidateCount() external view returns (uint256) {
        return candidateList.length;
    }

    function getCandidateDetails() external view returns (bytes32[] memory, uint256[] memory) {
        uint256 count = candidateList.length;
        uint256[] memory votes = new uint256[](count);
        for (uint256 i = 0; i < count; ) {
            votes[i] = candidateVotes[candidateList[i]];
            unchecked { i++; }
        }
        return (candidateList, votes);
    }

    function resetCandidates() external {
        for (uint256 i = 0; i < candidateList.length; ) {
            bytes32 candidateId = candidateList[i];
            isRegistered[candidateId] = false;
            candidateVotes[candidateId] = 0;
            unchecked { i++; }
        }
        delete candidateList;
    }
}
