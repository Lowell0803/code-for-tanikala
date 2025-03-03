// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract AdminCandidates {
    // Mapping to check if a candidate is registered
    mapping(bytes32 => bool) public isRegistered;
    // Mapping to store the number of votes for each candidate
    mapping(bytes32 => uint256) public candidateVotes;
    // Array to keep track of all candidate IDs
    bytes32[] public candidateList;

    event CandidateRegistered(bytes32 candidateId);
    event VoteCasted(bytes32 candidateId, uint256 newVoteCount);

    /**
     * @notice Registers candidates in a single transaction.
     * @param candidateIds An array of candidate unique IDs (bytes32).
     */
    function registerCandidates(bytes32[] calldata candidateIds) external {
        for (uint256 i = 0; i < candidateIds.length; i++) {
            bytes32 candidateId = candidateIds[i];
            // Only register if the candidate hasn't been registered yet
            if (!isRegistered[candidateId]) {
                isRegistered[candidateId] = true;
                candidateVotes[candidateId] = 0;
                candidateList.push(candidateId);
                emit CandidateRegistered(candidateId);
            }
        }
    }

    /**
     * @notice Allows voting for a candidate.
     * @param candidateId The unique ID of the candidate.
     */
    function voteForCandidate(bytes32 candidateId) external {
        require(isRegistered[candidateId], "Candidate not registered");
        candidateVotes[candidateId]++;
        emit VoteCasted(candidateId, candidateVotes[candidateId]);
    }

    /**
     * @notice Returns the total number of registered candidates.
     */
    function getCandidateCount() external view returns (uint256) {
        return candidateList.length;
    }
}
