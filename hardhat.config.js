// require("@nomicfoundation/hardhat-toolbox");

// module.exports = {
//   solidity: "0.8.21",
//   networks: {
//     hardhat: {}, // Built-in Hardhat network
//     localhost: {
//       url: "http://127.0.0.1:8545",
//     },
//   },
// };

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load environment variables

module.exports = {
  solidity: "0.8.21",
  networks: {
    hardhat: {}, // Built-in Hardhat network
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    amoy: {
      url: "https://rpc-amoy.polygon.technology",
      accounts: [`0x${process.env.PRIVATE_KEY}`], // Load private key from .env
      chainId: 80002,
    },
  },
};
