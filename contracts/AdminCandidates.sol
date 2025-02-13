// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    struct Candidate {
        string name;
        string party;
        string position;
        uint256 votes; // ✅ Track votes per candidate
    }

    mapping(string => Candidate[]) private candidates; // ✅ Position => List of Candidates
    mapping(address => bool) private hasVoted; // ✅ Track if a voter has voted
    string[] private positionList; // ✅ Store positions in an array

    address public admin;
    bool public isFinalized = false;

    event CandidatesSubmitted();
    event VoteSubmitted(string position, string name, address voter);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can perform this action");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function submitCandidates(
        string[] memory _positions,
        string[][] memory _names,
        string[][] memory _parties
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

    function vote(string memory _position, uint256 _index) public {
        require(isFinalized, "Voting cannot start until candidates are finalized!");

        // 🚨 Temporarily disabled for development (Uncomment for real deployment)
        // require(!hasVoted[msg.sender], "You have already voted!");

        candidates[_position][_index].votes++;

        // 🚨 Temporarily disabled for development (Uncomment for real deployment)
        // hasVoted[msg.sender] = true;

        emit VoteSubmitted(_position, candidates[_position][_index].name, msg.sender);
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
}
