// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const hre = require("hardhat");
import { ethers, upgrades } from "hardhat";
import { CryptoVoucher} from "../typechain-types";

async function main() {
  if (hre.network.name == "localhost") {
    const CryptoVoucherFactory = await ethers.getContractFactory("CryptoVoucher");
    //const CVoucher = await CVoucherFactory.attach("0x0Ef291E5e5b29b007B05aE921e094A3C429c83cB") as CVoucher;
    
    const CryptoVoucher = await CryptoVoucherFactory.deploy();

    console.log(
      `CryptoVoucher deployed to ${await CryptoVoucher.getAddress()}`
    );
    await CryptoVoucher.initialize();
  } else if (hre.network.name == "ethereum") {
    const CryptoVoucherFactory = await ethers.getContractFactory("CryptoVoucher");
    const CryptoVoucher = await upgrades.deployProxy(CryptoVoucherFactory, []);

    console.log(
      `CryptoVoucher deployed to ${await CryptoVoucher.getAddress()}`
    );
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
