import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import '@typechain/hardhat'
import '@nomicfoundation/hardhat-ethers'
import '@nomicfoundation/hardhat-chai-matchers'
import "@nomiclabs/hardhat-ganache";
import "hardhat-gas-reporter";
import "@openzeppelin/hardhat-upgrades";

import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      { version: "0.8.18", settings: { optimizer: { enabled: true, runs: 1000 }} },
      { version: "0.5.16", settings: { optimizer: { enabled: true, runs: 1000 }} },
      { version: "0.6.6", settings: { optimizer: { enabled: true, runs: 1000 }} },
    ]
  },
  gasReporter: {
    enabled: true,
    currency: 'USD',
    coinmarketcap: process.env.CMC_API_KEY
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: process.env.mnemonic
      }
    },
    ethereum: {
      url: "https://eth.llamarpc.com",
      chainId: 1,
      accounts: [process.env.OWNER_KEY],
    }
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHSCAN_API_KEY
    }
  },
};

export default config;