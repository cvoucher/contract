// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "hardhat/console.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

contract CryptoVoucher is UUPSUpgradeable, Initializable, OwnableUpgradeable {
  string public constant name = "CryptoVoucher";

  // Voucher settings
  // We pack the following into one uint256 `valueClaimFeeActive`:
  // 1. Voucher value (uint104)
  // 2. Claim fee (uint104)
  // 3. Claim Expiration (uint32)
  // 4. Active status(uint8)
  // This allows to fully configure voucher settings with one sstore operation => saves gas.
  struct NativeVoucherPacked {
    bytes32 redemptionHash;
    uint256 valueClaimFeeActive;
    uint256 claimedByExpiresAt;
  }
  struct NativeVoucherUnpacked {
    bytes32 redemptionHash;
    uint120 voucherValue;
    uint120 claimFee;
    uint16 isActive;
    address claimedBy;
    uint64 claimExpiresAt;
    uint32 expiredClaims;
  }
  // Fees
  address payable public feeReceiver;
  uint128 public createVoucherEthFeesMin;
  uint16 public createVoucherEthFees;
  uint16 public constant FEE_DIVISOR = 10_000;
  // Further settings
  uint64 public claimPeriod;

  bool private _inExecution;
  modifier ReentrancyGuard {
    require(_inExecution == false, "CV: Reentrancy");
    _inExecution = true;
    _;
    _inExecution = false;
  }

  function initialize() initializer public {
    __Ownable_init();
    feeReceiver = payable(msg.sender);
    createVoucherEthFeesMin = 0.005 ether;
    createVoucherEthFees = 200;
    claimPeriod = 10 minutes;
    _inExecution = false;
  }

  // [           256 BITS          ]
  // [ value | claimFee | isActive ]
  // |  120  |    120   |    16    |
  // [           256 BITS          ]
  // [ expiredClaims | claimedBy | expiresAt ]
  // |      32       |    160    |    64     |
  function _deserializeValueClaimFeeActive(uint256 valueClaimFeeActive) private pure returns(uint120 value, uint120 claimFee, uint16 isActive){
    value = uint120(valueClaimFeeActive >> 136);
    claimFee = uint120(valueClaimFeeActive >> 16);
    isActive = uint16(valueClaimFeeActive);
  }
  function _deserializeClaimedByExpiresAt(uint256 claimedByExpiresAt) private pure returns(address claimedBy, uint64 expiresAt, uint32 expiredClaims){
    expiredClaims = uint32(claimedByExpiresAt >> 232);
    claimedBy = address(uint160(claimedByExpiresAt >> 64));
    expiresAt = uint64(claimedByExpiresAt);
  }
  function _serializeValueClaimFeeActive(uint256 value, uint256 claimFee, uint256 isActive) private pure returns(uint256){
    return uint256(value << 136 | claimFee << 16 | isActive);
  }
  function _serializeClaimedByExpiresAt(address claimedBy, uint64 expiresAt, uint32 expiredClaims) private pure returns(uint256){
    return uint256(uint256(expiredClaims) << 232 | uint224(uint160(claimedBy)) << 64 | expiresAt);
  }

  event VoucherCreated(bytes32, uint);
  mapping(bytes32 => NativeVoucherPacked) public vouchers;
  function createEthVoucher(string memory voucherCode, bytes32 redemptionHash, uint128 claimFee) external payable ReentrancyGuard {
    // [VALIDATION START]
    bytes32 hashedCode = keccak256(abi.encodePacked(voucherCode));
    uint minFees = createVoucherEthFeesMin;
    uint16 isActive = uint16(vouchers[hashedCode].valueClaimFeeActive);
    require(isActive == 0, "CV: CODE_TAKEN");
    require(msg.value > minFees, "CV: MIN_FEES");
    // [VALIDATION STOP]
    uint feePercentage = createVoucherEthFees;
    uint ethFees = msg.value * feePercentage / (FEE_DIVISOR + feePercentage);
    if(ethFees < minFees)
      ethFees = minFees;
    
    (bool success,) = feeReceiver.call{value: ethFees}("");
    require(success, "CV: FEE_FAILED");
    // Now the voucher.
    uint voucherValue = msg.value - ethFees;
    vouchers[hashedCode].redemptionHash = redemptionHash;
    vouchers[hashedCode].valueClaimFeeActive = _serializeValueClaimFeeActive(voucherValue, claimFee, 1);
    vouchers[hashedCode].claimedByExpiresAt = 0;
    emit VoucherCreated(hashedCode, voucherValue);
  }

  function getEthVoucher(string memory voucherCode) external view returns(NativeVoucherUnpacked memory voucher){
    NativeVoucherPacked memory packedVoucher = vouchers[keccak256(abi.encodePacked(voucherCode))];
    (uint120 value, uint120 claimFee, uint16 isActive) =  _deserializeValueClaimFeeActive(packedVoucher.valueClaimFeeActive);
    (address claimedBy, uint64 claimExpiresAt, uint32 expiredClaims) = _deserializeClaimedByExpiresAt(packedVoucher.claimedByExpiresAt);
    return NativeVoucherUnpacked(packedVoucher.redemptionHash, value, claimFee, isActive, claimedBy, claimExpiresAt, expiredClaims);
  }

  // This method is used to lock redemption of a voucher.
  // Allows to safely execute the redemption method providing the secret without getting front-run.
  // Since arbitrary wallets can call this method over and over again to DOS, pay a user-defined fee to claim redemption.
  // After successfully redeeming the voucher, the caller gets their fee back.
  // NEVER EVER RUN `claimEthRedemption` AND `redeemCryptoVoucher` IN ONE TRANSACTION.
  // TO BE ABLE TO DO THAT YOU HAVE TO PROVIDE THE SECRET, THUS YOU CAN GET FRONT-RUN.
  // We do ave accumulated 
  function claimEthRedemption(bytes32 voucherCode) external payable ReentrancyGuard {
    (, uint120 claimFee, uint16 isActive) = _deserializeValueClaimFeeActive(vouchers[voucherCode].valueClaimFeeActive);
    (address claimedBy, uint64 claimExpiresAt, uint32 expiredClaims) = _deserializeClaimedByExpiresAt(vouchers[voucherCode].claimedByExpiresAt);
    
    require(isActive == 1, "CV: NOT_CLAIMABLE");
    require(msg.value == claimFee, "CV: WRONG_REDEEM_FEE");
    require(claimedBy == address(0) || block.timestamp >= claimExpiresAt, "CV: REDEMPTION_RUNNING");
    // Count how many times someone missed to redeem the voucher.
    // That way we can pay that to the final redeemer and the voucher service.
    if(claimedBy != address(0)){
      expiredClaims += 1;
    }
    // Lock for `claimPeriod`.
    vouchers[voucherCode].claimedByExpiresAt = _serializeClaimedByExpiresAt(msg.sender, uint64(block.timestamp) + claimPeriod, expiredClaims);
  }

  event VoucherRedeemed(bytes32, uint);
  // Calling this method is save if `claimEthRedemption` has been called in an earlier transaction.
  // While a user executes this function, redemption is locked and they can't be front-run.
  function redeemEthVoucher(bytes32 voucherCode, string memory secret) external ReentrancyGuard {
    uint valueClaimFeeActive = vouchers[voucherCode].valueClaimFeeActive;
    (address claimedBy, uint64 claimExpiresAt, uint32 expiredClaims) = _deserializeClaimedByExpiresAt(vouchers[voucherCode].claimedByExpiresAt);
    uint claimFeePayed = uint120(valueClaimFeeActive >> 16);
    require(claimedBy == msg.sender, "CV: NOT_CLAIMED");
    require(block.timestamp < claimExpiresAt, "CV: REDEEM_CLAIM_EXPIRED");
    require(keccak256(abi.encodePacked(secret)) == vouchers[voucherCode].redemptionHash, "CV: WRONG_SECRET");
    // In fact, we do not need to check if "isActive" is 1.
    // Both, voucher value and claim fees will be 0 so we cannot send ETH twice anyways.
    // And we already have an active check in claim voucher as well.
    // Redeem voucher and send back claim fees.
    uint voucherValue = uint120(valueClaimFeeActive >> 136);
    delete vouchers[voucherCode].valueClaimFeeActive;
    // Return full claim fee. It's just a security measure, no tax.
    uint redeemAndClaimValue = voucherValue + claimFeePayed;
    // Also, if there have been missed redemptions, pay back those claim fees as well.
    // Redeemers get 20% of the claim fees.
    if(expiredClaims > 0){
      uint totalExpiredClaimsValue = claimFeePayed * expiredClaims;
      uint CryptoVoucherShare = totalExpiredClaimsValue * 8_000 / FEE_DIVISOR;
      (bool expiredClaimsSuccess,) = payable(feeReceiver).call{value: CryptoVoucherShare}("");
      require(expiredClaimsSuccess, "CV: REDEEM_FAILED_EXPIRED_CLAIMS");
      redeemAndClaimValue += totalExpiredClaimsValue - CryptoVoucherShare;
    }
    (bool success,) = payable(msg.sender).call{value: redeemAndClaimValue}("");
    require(success, "CV: REDEEM_FAILED");
    emit VoucherRedeemed(voucherCode, uint(voucherValue));
  }

  // Owner utility functions.
  function updateSettings(
    address payable _feeReceiver, uint128 _createVoucherEthFeesMin,
    uint16 _createVoucherEthFees, uint64 _claimPeriod
  ) external onlyOwner {
    feeReceiver = _feeReceiver;
    // Voucher min fees must not be too high.
    require(_createVoucherEthFeesMin <= 1 ether, "CV: CVEF_TOO_HIGH");
    createVoucherEthFeesMin = _createVoucherEthFeesMin;
    // Voucher fees must not be too high.
    require(_createVoucherEthFees <= 1_000, "CV: CVEF_TOO_HIGH");
    createVoucherEthFees = _createVoucherEthFees;
    // Must not be too small to not make people run into claim penalty.
    require(_claimPeriod >= 30 seconds, "CV: RF_TOO_LOW");
    claimPeriod = _claimPeriod;
  }

  function _authorizeUpgrade(address) internal virtual override { require(msg.sender == owner(), "CV: NO_AUTH"); }
}