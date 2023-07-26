import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import { NumberLike } from "@nomicfoundation/hardhat-network-helpers/dist/src/types";
import { BigNumberish } from "ethers";

const parseEther = ethers.parseEther;
const inFutureTime = async() => (await time.latest()) + 3_000;

// Utility constants.
const HOUR = 3600;
const MINUTE = 60;

describe("CryptoVoucherToken", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployCVoucherFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, alice, bob] = await ethers.getSigners();

    const CryptoVoucherWeth = await ethers.getContractFactory("WETH");
    const CryptoVoucherUniswapFactory = await ethers.getContractFactory("CryptoVoucherTokenUniswapFactory");
    const CryptoVoucherUniswapRouter = await ethers.getContractFactory("CryptoVoucherTokenUniswapRouter");
    const CVoucher = await ethers.getContractFactory("CryptoVoucherToken");
    // Deploy contracts.
    const weth = (await CryptoVoucherWeth.deploy());
    const factoryContract = await CryptoVoucherUniswapFactory.deploy();
    const routerOwner = await CryptoVoucherUniswapRouter.deploy(await factoryContract.getAddress(), await weth.getAddress());
    const cvoucherOwner = await CVoucher.deploy(await routerOwner.getAddress());
    // Create pair and register taxes.
    await factoryContract.createPair(await weth.getAddress(), await cvoucherOwner.getAddress());
    const pairAddress = await factoryContract.getPair(await weth.getAddress(), await cvoucherOwner.getAddress());
    await cvoucherOwner.setTakeFeeFor(pairAddress, true);
    // Provide liquidity.
    await cvoucherOwner.approve(await routerOwner.getAddress(), ethers.MaxUint256);
    await routerOwner.addLiquidityETH(
      await cvoucherOwner.getAddress(),
      (await cvoucherOwner.TOTAL_SUPPLY()) * BigInt(10) / BigInt(100), 
      0, 0,
      await owner.getAddress(),
      (await time.latest()) + 1_000,
      { value: parseEther("100") }
    );
    return { cvoucherOwner, routerOwner, weth, owner, alice, bob };
  }

  describe("Deployment", function () {
    it("Initial settings are correct", async function () {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucher = await cvoucherOwner.connect(alice);
      
      expect(await cvoucher.TOTAL_SUPPLY()).to.eq(parseEther("10000000"));
      // Initial liquidity provided during tests.
      expect(await cvoucher.balanceOf(await owner.getAddress())).to.eq(
        (await cvoucher.TOTAL_SUPPLY()) * BigInt(90) / BigInt(100)
      );
      expect(await cvoucher.owner()).to.eq(await owner.getAddress());
      expect(await cvoucher.fees()).to.eql([parseEther("10000"), true, BigInt(400), BigInt(100), BigInt(500), BigInt(400), BigInt(100), BigInt(500)]);
      expect(await cvoucher.ignoreFees(await owner.getAddress())).to.eq(true);
      expect(await cvoucher.teamWallet()).to.eq(await owner.getAddress());
      expect(await cvoucher.liquidityWallet()).to.eq(await owner.getAddress());
    });
  });
  describe("Utility functions", function() {
    it("recoverERC20", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const tokensToReclaim = parseEther("100");
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.recoverERC20(await cvoucherAlice.getAddress(), tokensToReclaim)).to.be.revertedWith("Ownable: caller is not the owner");
      // Send alice some tokens to check if we can get them back.
      await cvoucherOwner.transfer(await alice.getAddress(), parseEther("1000"));
      await cvoucherOwner.whiteListTrade(await alice.getAddress(), true);
      await cvoucherAlice.transfer(await cvoucherAlice.getAddress(), tokensToReclaim);
      // Reclaim on owner.
      const contractTokenBalance = await cvoucherOwner.balanceOf(await cvoucherOwner.getAddress());
      await expect(cvoucherOwner.recoverERC20(await cvoucherOwner.getAddress(), contractTokenBalance)).to.be.revertedWith("CVT: INVALID_RECOVER");
    });
    it("recoverETH", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const ethToClaim = parseEther("24");
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.recoverETH(ethToClaim)).to.be.revertedWith("Ownable: caller is not the owner");
      // Send some ether from bob to contract.
      await bob.sendTransaction({ to: await cvoucherOwner.getAddress(), value: ethToClaim });
      // Reclaim on owner.
      const ownerEthBefore = await owner.provider.getBalance(await owner.getAddress());
      const contractEthBalance = await owner.provider.getBalance(await cvoucherOwner.getAddress());
      const recoverTxn = await (await cvoucherOwner.recoverETH(contractEthBalance)).wait();
      const recoverTxnCost = BigInt(recoverTxn?.gasUsed) * BigInt(recoverTxn?.gasPrice);
      const ownerEthGained = (await owner.provider.getBalance(await owner.getAddress())) - ownerEthBefore;

      expect(ownerEthGained).to.eq(ethToClaim - recoverTxnCost);
    });
    it("setFees", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.setFees(parseEther("10000"), true, 200, 200, 300, 300)).to.be.revertedWith("Ownable: caller is not the owner");
      // Maximum of buy and sell is 30% each.
      await expect(cvoucherOwner.setFees(parseEther("10000"), true, 1337, 2000, 400, 800)).to.be.revertedWith("CVT: TAXES_TOO_HIGH");
      await expect(cvoucherOwner.setFees(parseEther("10000"), true, 1337, 2000, 600, 2401)).to.be.revertedWith("CVT: TAXES_TOO_HIGH");
      await expect(cvoucherOwner.setFees(parseEther("10000"), true, 1337, 1664, 200, 4500)).to.be.revertedWith("CVT: TAXES_TOO_HIGH");
      await cvoucherOwner.setFees(parseEther("10000"), true, 350, 150, 1100, 400);
    });
    it("setTakeFee", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.setTakeFeeFor(await alice.getAddress(), false)).to.be.revertedWith("Ownable: caller is not the owner");
      // Set and unset fees to take.
      expect(await cvoucherOwner.takeFees(await alice.getAddress())).to.be.eq(false);
      await cvoucherOwner.setTakeFeeFor(await bob.getAddress(), true);
      expect(await cvoucherOwner.takeFees(await alice.getAddress())).to.be.eq(false);
      await cvoucherOwner.setTakeFeeFor(await alice.getAddress(), true);
      expect(await cvoucherOwner.takeFees(await alice.getAddress())).to.be.eq(true);
      await cvoucherOwner.setTakeFeeFor(await alice.getAddress(), false);
      expect(await cvoucherOwner.takeFees(await alice.getAddress())).to.be.eq(false);
    });
    it("setIgnoreFees", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.setIgnoreFees(await alice.getAddress(), true)).to.be.revertedWith("Ownable: caller is not the owner");
      // Set and unset ignore fees.
      expect(await cvoucherOwner.ignoreFees(await owner.getAddress())).to.be.eq(true);
      await cvoucherOwner.setIgnoreFees(await bob.getAddress(), false);
      expect(await cvoucherOwner.ignoreFees(await owner.getAddress())).to.be.eq(true);
      await cvoucherOwner.setIgnoreFees(await owner.getAddress(), false);
      expect(await cvoucherOwner.ignoreFees(await owner.getAddress())).to.be.eq(false);
      await cvoucherOwner.setIgnoreFees(await owner.getAddress(), true);
      expect(await cvoucherOwner.ignoreFees(await owner.getAddress())).to.be.eq(true);
    });
    it("setTeamWallet", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.setTeamWallet(await alice.getAddress())).to.be.revertedWith("Ownable: caller is not the owner");
      expect(await cvoucherOwner.teamWallet()).to.eq(await owner.getAddress());
      await cvoucherOwner.setTeamWallet(await bob.getAddress());
      expect(await cvoucherOwner.teamWallet()).to.eq(await bob.getAddress());
    });
    it("setLiquidityWallet", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.setLiquidityWallet(await alice.getAddress())).to.be.revertedWith("Ownable: caller is not the owner");
      expect(await cvoucherOwner.liquidityWallet()).to.eq(await owner.getAddress());
      await cvoucherOwner.setLiquidityWallet(await bob.getAddress());
      expect(await cvoucherOwner.liquidityWallet()).to.eq(await bob.getAddress());
    });
    it("startTrading", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.startTrading()).to.be.revertedWith("Ownable: caller is not the owner");
      expect(await cvoucherOwner.tradingEnabled()).to.eq(false);
      await cvoucherOwner.startTrading();
      expect(await cvoucherOwner.tradingEnabled()).to.eq(true);
    });
    it("whiteListTrade", async() => {
      const { cvoucherOwner, routerOwner, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const cvoucherAlice = await cvoucherOwner.connect(alice);
      // Disallowed by anyone but owner.
      await expect(cvoucherAlice.whiteListTrade(await alice.getAddress(), true)).to.be.revertedWith("Ownable: caller is not the owner");
      expect(await cvoucherOwner.tradingWhiteList(await alice.getAddress())).to.eq(false);
      await cvoucherOwner.whiteListTrade(await alice.getAddress(), true);
      expect(await cvoucherOwner.tradingWhiteList(await alice.getAddress())).to.eq(true);
      await cvoucherOwner.whiteListTrade(await alice.getAddress(), false);
      expect(await cvoucherOwner.tradingWhiteList(await alice.getAddress())).to.eq(false);
    });
  });
  describe("Trading", async() => {
    it("Trading disabled before actively launched", async() => {
      const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
      const routerAlice = await routerOwner.connect(alice);
      
      await expect(routerAlice.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, [await weth.getAddress(), await cvoucherOwner.getAddress()], await alice.getAddress(),
        await inFutureTime(), { value: parseEther("5") }
      )).to.be.revertedWith("UniswapV2: TRANSFER_FAILED");
      await cvoucherOwner.startTrading();
      await routerAlice.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, [await weth.getAddress(), await cvoucherOwner.getAddress()], await alice.getAddress(),
        await inFutureTime(), { value: parseEther("5") }
      );
    });
    describe("Buy", async() => {
      it("5% common fee", async() => {
        const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
        const routerBob = await routerOwner.connect(bob);
        const ethToSpend = parseEther("10");
        const tokensToGetWithoutFee = (await routerBob.getAmountsOut(ethToSpend, [await weth.getAddress(), await cvoucherOwner.getAddress()]))[1];
        const tokensToGetWithFee = tokensToGetWithoutFee * BigInt(95) / BigInt(100) + BigInt(1);
        const tokenBalance = await cvoucherOwner.balanceOf(await bob.getAddress());
        await cvoucherOwner.startTrading();
        await routerBob.swapExactETHForTokensSupportingFeeOnTransferTokens(
          0, [await weth.getAddress(), await cvoucherOwner.getAddress()],
          await bob.getAddress(), await inFutureTime(),
          {value: ethToSpend}
        );
        const tokensGained = (await cvoucherOwner.balanceOf(await bob.getAddress())) - tokenBalance;
        expect(tokensGained).to.eq(tokensToGetWithFee);
      });
      it("No fees for ignored addresses", async() => {
        const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
        const routerBob = await routerOwner.connect(bob);
        const etherToSpend = parseEther("100");
        await cvoucherOwner.setIgnoreFees(await bob.getAddress(), true);
        await cvoucherOwner.startTrading();
        const expectedTokensToGain = (await routerBob.getAmountsOut(etherToSpend, [await weth.getAddress(), await cvoucherOwner.getAddress()]))[1];
        const tokensGained = await buy(bob, await cvoucherOwner.getAddress(), await routerBob.getAddress(), await weth.getAddress(), etherToSpend);
        expect(tokensGained).to.eq(expectedTokensToGain);
      });
    });
    describe("Sell", async() => {
      type Sell = {
        after: number,
        fee: number
      };
      async function buyAndSellOnce(buyAfter: number, sellAfter: number, fee: number, fixture: any){
        return await buysAndSellAfter([buyAfter], [{after: sellAfter, fee: fee}], fixture);
      }
      async function buysAndSellAfter(buyAfterDeltas: number[], sellsAfter: Sell[], fixture = undefined){
        const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = fixture == undefined ? await loadFixture(deployCVoucherFixture) : fixture;
        const cvoucherBob = await cvoucherOwner.connect(bob);
        const routerBob = await routerOwner.connect(bob);
        const ethToSpend = parseEther("10");
        const initialContractTokenBalance = await cvoucherOwner.balanceOf(await cvoucherOwner.getAddress());
        let tokensGained = BigInt(0);
        let tokensTakenAsFees = BigInt(0);
        await cvoucherOwner.setFees(parseEther("1_000"), true, 500, 0, 500, 0);
        await cvoucherOwner.startTrading();
        for(const buyAfter of buyAfterDeltas){
          await time.increase(buyAfter - 1);
          const tokenBalance = await cvoucherOwner.balanceOf(await bob.getAddress());
          const buyFeesTaken = ((await routerBob.getAmountsOut(ethToSpend, [await weth.getAddress(), await cvoucherOwner.getAddress()]))[1]).mul(5).div(100);
          tokensTakenAsFees = tokensTakenAsFees.add(buyFeesTaken);
          await routerBob.swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, [await weth.getAddress(), await cvoucherOwner.getAddress()],
            await bob.getAddress(), await inFutureTime(),
            {value: ethToSpend}
          );
          const tokensGainedForPurchase = (await cvoucherOwner.balanceOf(await bob.getAddress())) - tokenBalance;
          tokensGained = tokensGained + tokensGainedForPurchase;
        }
        await cvoucherBob.approve(await routerBob.getAddress(), ethers.MaxUint256);
        const ethBalance = await owner.provider.getBalance(await bob.getAddress());
        // Fast-forward and sell.
        const tokensToSell = tokensGained / BigInt(sellsAfter.length);
        let expectedEthToGainWithFee = BigInt(0);
        for(const sell of sellsAfter){
          await time.increase(sell.after);
          expectedEthToGainWithFee = expectedEthToGainWithFee + 
            (await routerBob.getAmountsOut(tokensToSell * BigInt(100 - sell.fee) / BigInt(100), [await cvoucherOwner.getAddress(), await weth.getAddress()]))[1];
          tokensTakenAsFees = tokensTakenAsFees + (tokensToSell * BigInt(sell.fee) / BigInt(100));
          const txn = await (await routerBob.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensToSell, 0, 
            [await cvoucherOwner.getAddress(), await weth.getAddress()],
            await bob.getAddress(), await inFutureTime()
          )).wait();
          const txnCost = txn.gasUsed * txn.effectiveGasPrice;
          expectedEthToGainWithFee = expectedEthToGainWithFee - txnCost;
        }
        const ethGained = (await owner.provider.getBalance(await bob.getAddress())) - ethBalance;
        const contractTokensGained = (await cvoucherOwner.balanceOf(await cvoucherOwner.getAddress())) - initialContractTokenBalance;

        expect(ethGained).to.eq(expectedEthToGainWithFee);
        // Acceptance interval due to imprecise calculations.
        expect(contractTokensGained - tokensTakenAsFees).to.be.lessThanOrEqual(10);
      }
      it("No fees for ignored addresses", async() => {
        const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
        const routerBob = await routerOwner.connect(bob);
        await cvoucherOwner.setIgnoreFees(await bob.getAddress(), true);
        await cvoucherOwner.startTrading();
        const tokensGained = await buy(bob, await cvoucherOwner.getAddress(), await routerBob.getAddress(), await weth.getAddress(), parseEther("100"));
        const expectedEthToGain = (await routerBob.getAmountsOut(tokensGained, [await cvoucherOwner.getAddress(), await weth.getAddress()]))[1];
        const ethGained = await sell(bob, await cvoucherOwner.getAddress(), await routerBob.getAddress(), await weth.getAddress(), tokensGained);
        expect(ethGained).to.eq(expectedEthToGain);
      });
    });
    describe("Complex scenarios", async() => {
      it("#1: 2 accs buy (10k each) and sell once", async() => {
        await buyTwiceAndAliceSells(10000);
      });
      async function buyTwiceAndAliceSells(teamLiquidationPercentage: BigNumberish){
        const { cvoucherOwner, routerOwner, weth, owner, alice, bob } = await loadFixture(deployCVoucherFixture);
        await cvoucherOwner.setFees(parseEther("1200"), true, 500, 0, 500, 0);
        await cvoucherOwner.startTrading();
        const ownerTokensBefore = await cvoucherOwner.balanceOf(await owner.getAddress());
        let ownerEthBefore = await owner.provider.getBalance(await owner.getAddress());
        const aliceEthToSpend = (await routerOwner.getAmountsIn(parseEther("10000"), [await weth.getAddress(), await cvoucherOwner.getAddress()]))[0];
        await buy(alice, await cvoucherOwner.getAddress(), await routerOwner.getAddress(), await weth.getAddress(), aliceEthToSpend);
        const bobEthToSpend = (await routerOwner.getAmountsIn(parseEther("10000"), [await weth.getAddress(), await cvoucherOwner.getAddress()]))[0];
        await buy(bob, await cvoucherOwner.getAddress(), await routerOwner.getAddress(), await weth.getAddress(), bobEthToSpend);
        // Should not trigger liquidation yet.
        expect(await owner.provider.getBalance(await owner.getAddress())).to.eq(ownerEthBefore);
        // Contract should have around 20000 * 0.05 = 1000 tokens.
        const contractTokenFees = parseEther("1000");
        expect(await cvoucherOwner.balanceOf(await cvoucherOwner.getAddress())).to.eq(contractTokenFees + BigInt(824));
        // Selling gives 9000 * 0.05 = 450 tokens => 450 + 1000 = 1450.
        ownerEthBefore = await owner.provider.getBalance(await owner.getAddress());
        await sell(alice, await cvoucherOwner.getAddress(), await routerOwner.getAddress(), await weth.getAddress(), parseEther("9000"));
        const ownerEthGained = (await owner.provider.getBalance(await owner.getAddress())) - ownerEthBefore;
        
        expect(ownerEthGained).to.be.gt(BigInt(0));
      }
    });
    async function buy(from: SignerWithAdress, cvoucherAddress: string, routerAddress: string, wethAddress: string, amount: bigint){
      const userContract = await (await (await ethers.getContractFactory("CryptoVoucherToken")).connect(from)).attach(cvoucherAddress);
      const userRouter = await (await (await ethers.getContractFactory("CryptoVoucherTokenUniswapRouter")).connect(from)).attach(routerAddress);
      const weth = await (await (await ethers.getContractFactory("WETH")).connect(from)).attach(wethAddress);
      const tokenBalance = await userContract.balanceOf(await from.getAddress());
      await userRouter.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, [await weth.getAddress(), await userContract.getAddress()],
        await from.getAddress(), await inFutureTime(),
        {value: amount}
      );
      const tokensGained = (await userContract.balanceOf(await from.getAddress())) - tokenBalance;
      return tokensGained;
    }
    async function sell(from: SignerWithAdress, cvoucherAddress: string, routerAddress: string, wethAddress: string, amount: ethers.BigNumber){
      const userContract = await (await (await ethers.getContractFactory("CryptoVoucherToken")).connect(from)).attach(cvoucherAddress);
      const userRouter = await (await (await ethers.getContractFactory("CryptoVoucherTokenUniswapRouter")).connect(from)).attach(routerAddress);
      const weth = await (await (await ethers.getContractFactory("WETH")).connect(from)).attach(wethAddress);
      await userContract.approve(await userRouter.getAddress(), ethers.MaxUint256);
      const ethBalance = await from.provider.getBalance(await from.getAddress());
      const txn = await(await userRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
        amount, 0, 
        [await userContract.getAddress(), await weth.getAddress()],
        await from.getAddress(), await inFutureTime()
      )).wait();
      const txnCost = txn.gasUsed * txn.gasPrice;
      const ethGained = (await from.provider.getBalance(await from.getAddress())) - ethBalance;
      return ethGained + txnCost;
    }
  });
});