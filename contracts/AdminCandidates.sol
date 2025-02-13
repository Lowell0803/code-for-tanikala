// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    struct Candidate {
        string name;
        string party;
        string position;
    }

    mapping(string => Candidate[]) private candidates; // Position => List of Candidates
    string[] private positionList; // ✅ Store positions in an array

    address public admin;
    bool public isFinalized = false;

    event CandidatesSubmitted();

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

        // ✅ Clear previous position list
        delete positionList;

        for (uint256 i = 0; i < _positions.length; i++) {
            if (candidates[_positions[i]].length == 0) {
                positionList.push(_positions[i]); // ✅ Store position names
            }

            delete candidates[_positions[i]]; // Clear previous candidates

            for (uint256 j = 0; j < _names[i].length; j++) {
                candidates[_positions[i]].push(Candidate({
                    name: _names[i][j],
                    party: _parties[i][j],
                    position: _positions[i]
                }));
            }
        }
        isFinalized = true;
        emit CandidatesSubmitted();
    }

    function resetCandidates() public onlyAdmin {
        for (uint256 i = 0; i < positionList.length; i++) {
            delete candidates[positionList[i]]; // ✅ Clears stored candidates
        }
        delete positionList; // ✅ Clears stored positions
        isFinalized = false;
    }

    function getCandidates(string memory _position) public view returns (Candidate[] memory) {
        return candidates[_position];
    }
}
