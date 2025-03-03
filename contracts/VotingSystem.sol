// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract CandidatesStorage {
    bytes32[] public candidateIds;

    // This function replaces the stored candidate IDs with the new list.
    function storeCandidateIds(bytes32[] memory _candidateIds) public {
        // Clear previous candidate IDs.
        delete candidateIds;
        for (uint256 i = 0; i < _candidateIds.length; i++) {
            candidateIds.push(_candidateIds[i]);
        }
    }

    // Retrieve all stored candidate IDs.
    function getCandidateIds() public view returns (bytes32[] memory) {
        return candidateIds;
    }
}
