import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { TypedDataDomain, TypedDataEncoder, decodeBytes32String, encodeBytes32String } from "ethers";
import { ethers, upgrades } from "hardhat";
import { EIP712TypeDefinition } from "./EIP712.types";
import { CryptoVoucher } from "../typechain-types";

const parseEther = ethers.parseEther;
const ZeroAddress = ethers.ZeroAddress;
const hashString = (string: string) => ethers.keccak256(ethers.toUtf8Bytes(string));

describe("CryptoVoucher", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployCryptoVoucherFixture() {

    // Contracts are deployed using the first signer/account by default
    const [owner, alice, bob, charlie] = await ethers.getSigners();

    const cryptoVoucher = await ethers.getContractFactory("CryptoVoucher");
    const CryptoVoucher = await upgrades.deployProxy(cryptoVoucher, []);
    const ownerVoucher = await CryptoVoucher.connect(owner) as CryptoVoucher;
    const aliceVoucher = await CryptoVoucher.connect(alice) as CryptoVoucher;
    const bobVoucher = await CryptoVoucher.connect(bob) as CryptoVoucher;
    const charlieVoucher = await CryptoVoucher.connect(charlie) as CryptoVoucher;
    const voucherCode = ethers.solidityPacked(["string"], ["abcd-defg-5112-954J"]);
    const plainSecret = ethers.solidityPacked(["string"], ["CryptoVoucherTesting!"]);
    const secret = hashString(plainSecret);

    return { CryptoVoucher, owner, ownerVoucher, alice, aliceVoucher, bob, bobVoucher, charlie, charlieVoucher, voucherCode, plainSecret, secret };
  }

  describe("Deployment", function () {
    it("Simple deployment worked", async function () {
      const { CryptoVoucher, owner } = await loadFixture(deployCryptoVoucherFixture);

      expect(await CryptoVoucher.owner()).to.equal(owner.address);
      expect(await CryptoVoucher.feeReceiver()).to.eq(owner.address);
    });
    it("Only admin can upgrade to new contract address", async() => {
      const { CryptoVoucher, ownerVoucher, owner, aliceVoucher } = await loadFixture(deployCryptoVoucherFixture);

      await expect(aliceVoucher.upgradeTo(ZeroAddress)).to.be.revertedWith("CV: NO_AUTH");
      const contractFactory = await ethers.getContractFactory("CryptoVoucher");
      await upgrades.upgradeProxy(await CryptoVoucher.getAddress(), contractFactory);
    });
  });

  describe("Voucher", function () {
    describe("Create", () => {
      it("Not meeting minimum ETH fee", async() => {
        const { aliceVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);

        await expect(aliceVoucher.createEthVoucher(voucherCode, secret, parseEther("0.5"))).to.be.revertedWith("CV: MIN_FEES");
      });
      it("Fee is minimium ETH fee", async() => {
        const { aliceVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("0.1");
        const voucherMinFee = parseEther("0.005");

        await aliceVoucher.createEthVoucher(voucherCode, secret, parseEther("0.5"), {value: voucherValue});
        const generatedVoucher = await aliceVoucher.getEthVoucher(voucherCode);
        expect(generatedVoucher.voucherValue).to.eq(voucherValue - voucherMinFee);
      });
      it("Fee is ETH fee percentage", async() => {
        const { aliceVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("5");
        // Fee is 2%
        const voucherFee = voucherValue * BigInt(2) / BigInt(100);

        await aliceVoucher.createEthVoucher(voucherCode, secret, parseEther("0.5"), {value: voucherValue + voucherFee});
        const generatedVoucher = await aliceVoucher.getEthVoucher(voucherCode);
        expect(generatedVoucher.voucherValue).to.eq(voucherValue);
      });
      it("Valid voucher", async() => {
        const { owner, alice, aliceVoucher, secret, plainSecret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("15");
        // Fee is 2%
        const voucherFee = voucherValue * BigInt(2) / BigInt(100);

        const ownerBalanceBefore = await owner.provider.getBalance(owner.address);
        await aliceVoucher.createEthVoucher(voucherCode, secret, parseEther("0.5"), {value: voucherValue + voucherFee});
        const generatedVoucher = await aliceVoucher.getEthVoucher(voucherCode);
        const ownerEthGained = (await owner.provider.getBalance(owner.address)) - ownerBalanceBefore;
        expect(generatedVoucher).to.eql([
          secret,
          voucherValue,
          parseEther("0.5"),
          BigInt(1),
          ZeroAddress,
          BigInt(0),
          BigInt(0)
        ]);
        expect(ownerEthGained).to.eq(voucherFee);
      });
    });
    describe("Claim to know secret", () => {
      it("Can't claim secret of vouchers that do not exist", async() => {
        const { owner, alice, aliceVoucher } = await loadFixture(deployCryptoVoucherFixture);

        await expect(aliceVoucher.claimEthRedemption(hashString("1"))).to.be.revertedWith("CV: NOT_CLAIMABLE");
        await expect(aliceVoucher.claimEthRedemption(hashString("12121"))).to.be.revertedWith("CV: NOT_CLAIMABLE");
        await expect(aliceVoucher.claimEthRedemption(hashString("ffda-sdfs-FSD1-h563"))).to.be.revertedWith("CV: NOT_CLAIMABLE");
      });
      it("Claim fees need to exactly match", async() => {
        const { aliceVoucher, bobVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        const voucher1ClaimFee = parseEther("60");
        const voucher2ClaimFee = voucher1ClaimFee + parseEther("10");
        const voucherCode2 = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["abcd-defg-5112-954j"]);
        await aliceVoucher.createEthVoucher(voucherCode, secret, voucher1ClaimFee, {value: voucherValue});
        await aliceVoucher.createEthVoucher(voucherCode2, secret, voucher2ClaimFee, {value: voucherValue});
        // Sent claim fee has to match EXACTLY.
        await expect(bobVoucher.claimEthRedemption(hashString(voucherCode))).to.be.revertedWith("CV: WRONG_REDEEM_FEE");
        await expect(bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucher1ClaimFee - BigInt(1)})).to.be.revertedWith("CV: WRONG_REDEEM_FEE");
        await expect(bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucher1ClaimFee + BigInt(1)})).to.be.revertedWith("CV: WRONG_REDEEM_FEE");
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucher1ClaimFee});
        await bobVoucher.claimEthRedemption(hashString(voucherCode2), {value: voucher2ClaimFee});
      });
      it("Claim only possible if nobody other already claims", async() => {
        const { aliceVoucher, bobVoucher, charlieVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        const voucherClaimFee = parseEther("60");
        
        await aliceVoucher.createEthVoucher(voucherCode, secret, voucherClaimFee, {value: voucherValue});
        await charlieVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        await expect(bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee})).to.be.revertedWith("CV: REDEMPTION_RUNNING");
      });
      it("Claim by someone other while already claimed only after lock time passed", async() => {
        const { aliceVoucher, bobVoucher, charlieVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        const voucherClaimFee = parseEther("60");
        const lockTime = await aliceVoucher.claimPeriod();
        
        await aliceVoucher.createEthVoucher(voucherCode, secret, voucherClaimFee, {value: voucherValue});
        await charlieVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        await expect(charlieVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee})).to.be.revertedWith("CV: REDEMPTION_RUNNING");
        // Wait until almost enough time has passed.
        await time.increase(lockTime - BigInt(10));
        await expect(bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee})).to.be.revertedWith("CV: REDEMPTION_RUNNING");
        // Wait one more second. Now it should be possible to claim.
        await time.increase(10);
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
      });
      it("Successful, fully-functional first claim", async() => {
        const { aliceVoucher, bob, bobVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        const voucherClaimFee = parseEther("60");

        await aliceVoucher.createEthVoucher(voucherCode, secret, voucherClaimFee, {value: voucherValue});
        const claimTxn = await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        const txnTimestamp = BigInt(await (await ethers.provider.getBlock(claimTxn.blockNumber))!.timestamp);
        const claimPeriod = await aliceVoucher.claimPeriod();
        const claimedVoucher = await aliceVoucher.getEthVoucher(voucherCode);
        expect(claimedVoucher.claimedBy).to.eq(bob.address);
        expect(claimedVoucher.claimExpiresAt).to.eq(txnTimestamp + claimPeriod);
      });
      it("Successful, fully-functional second claim", async() => {
        const { aliceVoucher, bob, bobVoucher, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        const voucherClaimFee = parseEther("60");
        const claimPeriod = await aliceVoucher.claimPeriod();
        const bobEthBalance = await ethers.provider.getBalance(bob.address);

        await aliceVoucher.createEthVoucher(voucherCode, secret, voucherClaimFee, {value: voucherValue});
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        await time.increase(claimPeriod + BigInt(10));
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        const bobEthSpent = bobEthBalance - (await ethers.provider.getBalance(bob.address));
        // Bob spent two times the claim fee.
        expect(bobEthSpent).to.be.gt(voucherClaimFee * BigInt(2));
      });
    });
    describe("Redeem ETH voucher", () => {
      async function signMessage(signer: HardhatEthersSigner, contractAddress: string, message: Object) {
        const domain: TypedDataDomain = {
          name: "CryptoVoucher",
          version: "1",
          chainId: 31337,
          verifyingContract: contractAddress
        }
        const types:EIP712TypeDefinition = {
          redeemEthVoucher: [
            { name: "id", type: "uint256" },
            { name: "creator", type: "address" },
            { name: "secret", type: "bytes32"}
          ]
        }

        return await signer.signTypedData(domain, types, message);
      }
      async function aliceCreatesVoucher() {
        const { owner, alice, aliceVoucher, bob, bobVoucher, plainSecret, secret, voucherCode } = await loadFixture(deployCryptoVoucherFixture);
        const voucherValue = parseEther("2");
        // Creation fees are 2% of total value. Add this.
        const voucherFee = voucherValue * BigInt(2) / BigInt(100);
        const voucherClaimFee = parseEther("60");

        await aliceVoucher.createEthVoucher(voucherCode, secret, voucherClaimFee, {value: voucherValue + voucherFee});

        return { voucherCode, voucherClaimFee, plainSecret, secret, voucherValue, voucherFee };
      }

      it("Voucher must be claimed by wallet currently redeeming", async() => {
        const { alice, bobVoucher, charlieVoucher } = await loadFixture(deployCryptoVoucherFixture);
        const { voucherCode, voucherClaimFee, secret } = await aliceCreatesVoucher();
        // Bob did not claim yet.
        await expect(bobVoucher.redeemEthVoucher(hashString(voucherCode), secret)).to.be.revertedWith("CV: NOT_CLAIMED");
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        // Now bob claimed. Charlie can neither claim nor redeem, even though he has the secret and the signature.
        await expect(charlieVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee})).to.be.revertedWith("CV: REDEMPTION_RUNNING");
        await expect(charlieVoucher.redeemEthVoucher(hashString(voucherCode), secret)).to.be.revertedWith("CV: NOT_CLAIMED");
      });
      it("Voucher claim period expired", async() => {
        const { alice, bobVoucher } = await loadFixture(deployCryptoVoucherFixture);
        const { voucherCode, voucherClaimFee, plainSecret } = await aliceCreatesVoucher();
        const claimPeriod = await bobVoucher.claimPeriod();

        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        // Let enough time pass to fail redemption even though plainSecret and signature are correct.
        await time.increase(claimPeriod);
        await expect(bobVoucher.redeemEthVoucher(hashString(voucherCode), plainSecret)).to.be.revertedWith("CV: REDEEM_CLAIM_EXPIRED");
      });
      it("Fully-functional voucher redemption", async() => {
        const { owner, bob, bobVoucher, voucherCode, plainSecret, secret } = await loadFixture(deployCryptoVoucherFixture);
        const { voucherClaimFee, voucherValue } = await aliceCreatesVoucher();

        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        // Some arbitrary time passing.
        await time.increase(47);
        const feeReceiverEthBefore = await ethers.provider.getBalance(owner.address);
        const bobEthBefore = await ethers.provider.getBalance(bob.address);
        const redeemTxn = await (await bobVoucher.redeemEthVoucher(hashString(voucherCode), plainSecret)).wait();
        const redeemTxnCost = redeemTxn!.gasPrice * redeemTxn!.cumulativeGasUsed;
        const feeReceiverEthGained = await ethers.provider.getBalance(owner.address) - feeReceiverEthBefore;
        const bobEthGained = await ethers.provider.getBalance(bob.address) - bobEthBefore;
        expect(bobEthGained).to.eq(voucherValue + voucherClaimFee - redeemTxnCost);
        // Voucher should be deleted.
        expect((await bobVoucher.getEthVoucher(voucherCode)).slice(0, 4)).to.be.eql([secret, BigInt(0), BigInt(0), BigInt(0)]);
      });
      it("Reclaim voucher redemption after claim period and redeem then", async() => {
        const { owner, alice, aliceVoucher, bob, bobVoucher, charlieVoucher, voucherCode, plainSecret } = await loadFixture(deployCryptoVoucherFixture);
        const { voucherClaimFee, voucherValue, secret } = await aliceCreatesVoucher();
        const claimPeriod = await bobVoucher.claimPeriod();
        const redeemClainExpiredBonus = voucherClaimFee * BigInt(20) / BigInt(100);

        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        // Some arbitrary time passing.
        await time.increase(claimPeriod);
        await expect(bobVoucher.redeemEthVoucher(hashString(voucherCode), plainSecret)).to.be.revertedWith("CV: REDEEM_CLAIM_EXPIRED");
        await bobVoucher.claimEthRedemption(hashString(voucherCode), {value: voucherClaimFee});
        const feeReceiverEthBefore = await ethers.provider.getBalance(owner.address);
        const bobEthBefore = await ethers.provider.getBalance(bob.address);
        const redeemTxn = await (await bobVoucher.redeemEthVoucher(hashString(voucherCode), plainSecret)).wait();
        const redeemTxnCost = redeemTxn!.gasPrice * redeemTxn!.cumulativeGasUsed;
        const feeReceiverEthGained = await ethers.provider.getBalance(owner.address) - feeReceiverEthBefore;
        const bobEthGained = await ethers.provider.getBalance(bob.address) - bobEthBefore;
        expect(bobEthGained).to.eq(voucherValue + voucherClaimFee + redeemClainExpiredBonus - redeemTxnCost);
        // Voucher claim values.
        expect((await bobVoucher.getEthVoucher(voucherCode)).slice(0, 4)).to.be.eql([secret, BigInt(0), BigInt(0), BigInt(0)]);
      });
    });
  });
});
