// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

contract AdminCandidates {
    struct Candidate {
        string name;
        string party;
        string position;
    }

    mapping(string => Candidate[]) private candidates;
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

        for (uint256 i = 0; i < _positions.length; i++) {
            delete candidates[_positions[i]];
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
        isFinalized = false;
    }

    function getCandidates(string memory _position) public view returns (Candidate[] memory) {
        return candidates[_position];
    }
}
