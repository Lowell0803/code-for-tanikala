// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    struct Candidate {
        bytes32 name;
        bytes32 party;
        uint256 votes;
    }

    struct CandidateEntry {
        bytes32 name;
        bytes32 party;
    }

    struct Winner {
        bytes32 position;
        bytes32 name;
        bytes32 party;
        uint256 votes;
    }
    
    // Mapping from a position (bytes32) to an array of Candidate structs.
    mapping(bytes32 => Candidate[]) private candidates;
    // Mapping to store each candidate's voter hashes.
    mapping(bytes32 => mapping(uint256 => bytes32[])) private candidateVoterHashes;
    // Prevents double voting.
    mapping(bytes32 => bool) private hasVotedHash;
    // List of positions.
    bytes32[] private positionList;
    
    // For board member positions, store a unique program ID.
    mapping(bytes32 => bytes32) public boardMemberProgramIDs;

    address public admin;
    bool public isFinalized = false;

    event CandidatesSubmitted();
    event CandidatesReset();
    event VoteSubmitted(bytes32 position, bytes32 name, bytes32 voterHash);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can perform this action");
        _;
    }

    constructor() {
        admin = msg.sender;
    }
    
    // Helper function to decode a bytes32 to string.
    function decodeBytes32String(bytes32 _data) internal pure returns (string memory) {
        uint256 len = 0;
        while (len < 32 && _data[len] != 0) {
            unchecked { len++; }
        }
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = _data[i];
        }
        return string(result);
    }
    
    // Modified: Returns true if the decoded position contains "Board Member"
    function isBoardMemberPosition(bytes32 position) internal pure returns (bool) {
        string memory posStr = decodeBytes32String(position);
        bytes memory posBytes = bytes(posStr);
        bytes memory target = "Board Member";
        if (posBytes.length < target.length) return false;
        for (uint256 i = 0; i <= posBytes.length - target.length; i++) {
            bool isMatch = true;
            for (uint256 j = 0; j < target.length; j++) {
                if (posBytes[i + j] != target[j]) {
                    isMatch = false;
                    break;
                }
            }
            if (isMatch) return true;
        }
        return false;
    }

    
    // Submit candidates for each position.
    // _positions: array of positions (as bytes32)
    // _candidates: 2D array; for each position an array of CandidateEntry values.
    // _boardMemberProgramIDs: for board member positions, supply a unique program ID.
    // For non-board member positions, pass an empty bytes32.
    function submitCandidates(
        bytes32[] memory _positions,
        CandidateEntry[][] memory _candidates,
        bytes32[] memory _boardMemberProgramIDs
    ) public onlyAdmin {
        require(!isFinalized, "Candidates are already finalized!");
        delete positionList;
        for (uint256 i = 0; i < _positions.length; i++) {
            if (candidates[_positions[i]].length == 0) {
                positionList.push(_positions[i]);
            }
            delete candidates[_positions[i]];
            for (uint256 j = 0; j < _candidates[i].length; j++) {
                candidates[_positions[i]].push(Candidate({
                    name: _candidates[i][j].name,
                    party: _candidates[i][j].party,
                    votes: 0
                }));
                delete candidateVoterHashes[_positions[i]][j];
            }
            // For board member positions, store the program ID.
            if (isBoardMemberPosition(_positions[i])) {
                boardMemberProgramIDs[_positions[i]] = _boardMemberProgramIDs[i];
            }
        }
        isFinalized = true;
        emit CandidatesSubmitted();
    }

    // Allow a voter to cast votes in batch.
    function batchVote(
        bytes32[] memory _positions,
        uint256[] memory _indices,
        bytes32 _voterHash
    ) public {
        require(isFinalized, "Voting cannot start until candidates are finalized!");
        require(_positions.length == _indices.length, "Mismatched input lengths");
        require(!hasVotedHash[_voterHash], "Voter has already voted");
        hasVotedHash[_voterHash] = true;
        for (uint256 i = 0; i < _positions.length; i++) {
            bytes32 pos = _positions[i];
            uint256 idx = _indices[i];
            require(idx < candidates[pos].length, "Invalid candidate index");
            candidates[pos][idx].votes++;
            candidateVoterHashes[pos][idx].push(_voterHash);
            emit VoteSubmitted(pos, candidates[pos][idx].name, _voterHash);
        }
    }
    
    // Return an array of CandidateEntry for a given position.
    function getCandidates(bytes32 _position) public view returns (CandidateEntry[] memory) {
        Candidate[] storage posCandidates = candidates[_position];
        CandidateEntry[] memory entries = new CandidateEntry[](posCandidates.length);
        for (uint256 i = 0; i < posCandidates.length; i++) {
            entries[i] = CandidateEntry(posCandidates[i].name, posCandidates[i].party);
        }
        return entries;
    }
    
    // Return all candidates and their vote counts as flat arrays.
    function getVoteCounts() public view returns (CandidateEntry[] memory, uint256[] memory) {
        uint256 totalCandidates = 0;
        for (uint256 i = 0; i < positionList.length; i++) {
            totalCandidates += candidates[positionList[i]].length;
        }
        CandidateEntry[] memory allCandidates = new CandidateEntry[](totalCandidates);
        uint256[] memory votes = new uint256[](totalCandidates);
        uint256 index = 0;
        for (uint256 i = 0; i < positionList.length; i++) {
            Candidate[] storage posCandidates = candidates[positionList[i]];
            for (uint256 j = 0; j < posCandidates.length; j++) {
                allCandidates[index] = CandidateEntry(posCandidates[j].name, posCandidates[j].party);
                votes[index] = posCandidates[j].votes;
                unchecked { index++; }
            }
        }
        return (allCandidates, votes);
    }
    
    // Reset all candidates and positions.
    function resetCandidates() public onlyAdmin {
        for (uint256 i = 0; i < positionList.length; i++) {
            bytes32 pos = positionList[i];
            delete candidates[pos];
        }
        delete positionList;
        isFinalized = false;
        emit CandidatesReset();
    }
    
    // Get the list of positions.
    function getPositionList() public view returns (bytes32[] memory) {
        return positionList;
    }
    
    // Get the voter hashes for a candidate under a position.
    function getVoterHashes(bytes32 _position, uint256 _index) public view returns (bytes32[] memory) {
        return candidateVoterHashes[_position][_index];
    }
    
    // Determine and return the winner for each position.
    function getWinners() public view returns (Winner[] memory) {
        uint256 len = positionList.length;
        Winner[] memory winners = new Winner[](len);
        for (uint256 i = 0; i < len; i++) {
            bytes32 pos = positionList[i];
            Candidate[] storage posCandidates = candidates[pos];
            uint256 highestVotes = 0;
            uint256 winnerIndex = 0;
            bool found = false;
            for (uint256 j = 0; j < posCandidates.length; j++) {
                if (!found || posCandidates[j].votes > highestVotes) {
                    highestVotes = posCandidates[j].votes;
                    winnerIndex = j;
                    found = true;
                }
            }
            winners[i] = Winner({
                position: pos,
                name: posCandidates[winnerIndex].name,
                party: posCandidates[winnerIndex].party,
                votes: highestVotes
            });
        }
        return winners;
    }
}
