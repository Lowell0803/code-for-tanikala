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

    // This struct is used by the getWinners function
    struct Winner {
        bytes32 position;
        bytes32 name;
        bytes32 party;
        uint256 votes;
    }

    // Mapping from a position (bytes32) to an array of Candidate structs
    mapping(bytes32 => Candidate[]) private candidates;
    // Instead of a mapping that's hard to iterate, we store each voter's hash per candidate here.
    mapping(bytes32 => mapping(uint256 => bytes32[])) private candidateVoterHashes;
    // Prevents a given voter (hashed) from voting more than once.
    mapping(bytes32 => bool) private hasVotedHash;
    // List of positions (e.g., "President", "VicePresident", etc.)
    bytes32[] private positionList;

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

    // Submit candidates for each position.
    // _positions: an array of positions (as bytes32)
    // _candidates: a 2D array; for each position an array of CandidateEntry values.
    function submitCandidates(
        bytes32[] memory _positions,
        CandidateEntry[][] memory _candidates
    ) public onlyAdmin {
        require(!isFinalized, "Candidates are already finalized!");
        // Reset the positions list
        delete positionList;

        for (uint256 i = 0; i < _positions.length; i++) {
            // Only add the position if no candidates exist for it yet
            if(candidates[_positions[i]].length == 0){
                positionList.push(_positions[i]);
            }
            // Reset the candidates for this position
            delete candidates[_positions[i]];
            // For each candidate entry, push a new Candidate with 0 votes.
            for (uint256 j = 0; j < _candidates[i].length; j++) {
                candidates[_positions[i]].push(Candidate({
                    name: _candidates[i][j].name,
                    party: _candidates[i][j].party,
                    votes: 0
                }));
                // Ensure the voter hashes array for this candidate is empty.
                delete candidateVoterHashes[_positions[i]][j];
            }
        }
        isFinalized = true;
        emit CandidatesSubmitted();
    }

    // Allow a voter to cast votes in batch.
    // _positions: array of positions to vote for
    // _indices: array of candidate indices corresponding to each position
    // _voterHash: the hashed identifier of the voter
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

            // Increase the vote count for the candidate
            candidates[pos][idx].votes++;
            // Store the voter's hash for this candidate vote
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
        uint256 totalCandidates;
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
                index++;
            }
        }
        return (allCandidates, votes);
    }

    // Resets all candidates and positions.
    function resetCandidates() public onlyAdmin {
        for (uint256 i = 0; i < positionList.length; i++) {
            bytes32 pos = positionList[i];
            delete candidates[pos];
            // Note: candidateVoterHashes mapping will naturally be overwritten when new candidates are submitted.
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
    // If multiple candidates tie, the one with the lowest index is returned.
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
