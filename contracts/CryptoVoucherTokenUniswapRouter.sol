import "@uniswap/v2-periphery/contracts/UniswapV2Router02.sol";

contract CryptoVoucherTokenUniswapRouter is UniswapV2Router02 {

  constructor(address factory, address weth) UniswapV2Router02(factory, weth) public {
    
  }
}