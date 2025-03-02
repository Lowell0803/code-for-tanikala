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

    // This struct is used by the getWinners function.
    struct Winner {
        bytes32 position;
        bytes32 name;
        bytes32 party;
        uint256 votes;
    }
    
    // New struct to hold extra Board Member program information using 3 segments.
    struct BoardMemberInfo {
        bytes32 programPart1;
        bytes32 programPart2;
        bytes32 programPart3;
    }

    // Mapping from a position (bytes32) to an array of Candidate structs.
    mapping(bytes32 => Candidate[]) private candidates;
    // Mapping to store each candidate's voter hashes.
    mapping(bytes32 => mapping(uint256 => bytes32[])) private candidateVoterHashes;
    // Prevents a given voter (hashed) from voting more than once.
    mapping(bytes32 => bool) private hasVotedHash;
    // List of positions (e.g., "President", "Vice President", etc.)
    bytes32[] private positionList;
    // For Board Member positions, store extra program data (3 parts).
    mapping(bytes32 => BoardMemberInfo) public boardMemberInfo;

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
    
    // Helper function to decode bytes32 to string (similar to ethers.decodeBytes32String)
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
    
    // Helper: returns true if the given position ends with " - Board Member"
    function isBoardMemberPosition(bytes32 position) internal pure returns (bool) {
        string memory posStr = decodeBytes32String(position);
        bytes memory posBytes = bytes(posStr);
        bytes memory suffix = bytes(" - Board Member");
        if (posBytes.length < suffix.length) {
            return false;
        }
        for (uint256 i = 0; i < suffix.length; i++) {
            if (posBytes[posBytes.length - suffix.length + i] != suffix[i]) {
                return false;
            }
        }
        return true;
    }
    
    // Submit candidates for each position.
    // _positions: an array of positions (as bytes32)
    // _candidates: a 2D array; for each position an array of CandidateEntry values.
    // _boardMemberProgramsPart1, _boardMemberProgramsPart2, _boardMemberProgramsPart3:
    // For Board Member positions, supply the full program string split into three parts.
    // For non-Board Member positions, pass zero-value bytes32.
    function submitCandidates(
        bytes32[] memory _positions,
        CandidateEntry[][] memory _candidates,
        bytes32[] memory _boardMemberProgramsPart1,
        bytes32[] memory _boardMemberProgramsPart2,
        bytes32[] memory _boardMemberProgramsPart3
    ) public onlyAdmin {
        require(!isFinalized, "Candidates are already finalized!");
        // Reset the positions list.
        delete positionList;
        for (uint256 i = 0; i < _positions.length; i++) {
            // Only add the position if no candidates exist for it yet.
            if(candidates[_positions[i]].length == 0){
                positionList.push(_positions[i]);
            }
            // Reset the candidates for this position.
            delete candidates[_positions[i]];
            for (uint256 j = 0; j < _candidates[i].length; j++) {
                candidates[_positions[i]].push(Candidate({
                    name: _candidates[i][j].name,
                    party: _candidates[i][j].party,
                    votes: 0
                }));
                // Clear voter hashes for this candidate.
                delete candidateVoterHashes[_positions[i]][j];
            }
            // For Board Member positions, store extra program data.
            if(isBoardMemberPosition(_positions[i])) {
                boardMemberInfo[_positions[i]] = BoardMemberInfo({
                    programPart1: _boardMemberProgramsPart1[i],
                    programPart2: _boardMemberProgramsPart2[i],
                    programPart3: _boardMemberProgramsPart3[i]
                });
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
    
    // Get the voter hashes for a given candidate under a position.
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
