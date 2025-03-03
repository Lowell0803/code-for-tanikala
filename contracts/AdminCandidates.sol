// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    struct Candidate {
        bytes32 name;   // Changed from string to bytes32
        bytes32 party;  // Changed from string to bytes32
        string position;
        uint256 votes;
    }

    // Mapping of position (string) to an array of candidates
    mapping(string => Candidate[]) private candidates;
    mapping(address => bool) private hasVoted; // (remains, though unused)
    string[] private positionList;

    address public admin;
    bool public isFinalized = false;

    event CandidatesSubmitted();
    event CandidatesReset();
    // Updated event: candidate name is now bytes32
    event VoteSubmitted(string position, bytes32 name, string voterHash);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can perform this action");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // Note: _names and _parties are now bytes32 arrays.
    function submitCandidates(
        string[] memory _positions,
        bytes32[][] memory _names,
        bytes32[][] memory _parties
    ) public onlyAdmin {
        require(!isFinalized, "Candidates are already finalized!");
        delete positionList;

        for (uint256 i = 0; i < _positions.length; i++) {
            if (candidates[_positions[i]].length == 0) {
                positionList.push(_positions[i]);
            }

            delete candidates[_positions[i]];
            for (uint256 j = 0; j < _names[i].length; j++) {
                candidates[_positions[i]].push(Candidate({
                    name: _names[i][j],
                    party: _parties[i][j],
                    position: _positions[i],
                    votes: 0
                }));
            }
        }
        isFinalized = true;
        emit CandidatesSubmitted();
    }

    // Removed storage of voterHashes to save gas.
    function batchVote(
        string[] memory _positions,
        uint256[] memory _indices,
        string memory _voterHash
    ) public {
        require(isFinalized, "Voting cannot start until candidates are finalized!");
        require(_positions.length == _indices.length, "Mismatched input lengths");

        for (uint256 i = 0; i < _positions.length; i++) {
            candidates[_positions[i]][_indices[i]].votes++;
            emit VoteSubmitted(_positions[i], candidates[_positions[i]][_indices[i]].name, _voterHash);
        }
    }

    function getCandidates(string memory _position) public view returns (Candidate[] memory) {
        return candidates[_position];
    }

    function getVoteCounts() public view returns (Candidate[] memory) {
        uint256 totalCandidates;
        for (uint256 i = 0; i < positionList.length; i++) {
            totalCandidates += candidates[positionList[i]].length;
        }

        Candidate[] memory allCandidates = new Candidate[](totalCandidates);
        uint256 index = 0;

        for (uint256 i = 0; i < positionList.length; i++) {
            Candidate[] storage positionCandidates = candidates[positionList[i]];
            for (uint256 j = 0; j < positionCandidates.length; j++) {
                allCandidates[index] = positionCandidates[j];
                index++;
            }
        }

        return allCandidates;
    }

    function resetCandidates() public onlyAdmin {
        for (uint256 i = 0; i < positionList.length; i++) {
            delete candidates[positionList[i]];
        }
        delete positionList;
        isFinalized = false;
        emit CandidatesReset();
    }
}
