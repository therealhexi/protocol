const { MAX_UINT_VAL } = require("@uma/common");
const { toWei, toBN, fromWei } = web3.utils;
const { getTruffleContract } = require("@uma/core");
const truffleContract = require("@truffle/contract");

// Tested Contract
const UniswapV2Broker = getTruffleContract("UniswapV2Broker", web3);
const Token = getTruffleContract("ExpandedERC20", web3);
const WETH9 = getTruffleContract("WETH9", web3);

// Helper Contracts
const UniswapV2Factory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json");
const UniswapV2Router02 = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

let tokenA;
let tokenB;
let factory;
let router;
let uniswapV2Broker;
let pair;
let pairAddress;

// Takes in a json object from a compiled contract and returns a truffle contract instance that can be deployed.
const createContractObjectFromJson = (contractJsonObject) => {
  let truffleContractCreator = truffleContract(contractJsonObject);
  truffleContractCreator.setProvider(web3.currentProvider);
  return truffleContractCreator;
};

// Returns the current spot price of a uniswap pool, scaled to 4 decimal points.
const getPoolSpotPrice = async () => {
  const poolTokenABallance = await tokenA.balanceOf(pairAddress);
  const poolTokenBBallance = await tokenB.balanceOf(pairAddress);
  return Number(fromWei(poolTokenABallance.mul(toBN(toWei("1"))).div(poolTokenBBallance))).toFixed(4);
};

// For a given amountIn, return the amount out expected from a trade. aToB defines the direction of the trade. If aToB
// is true then the trader is exchanging token a for token b. Else, exchanging token b for token a.
const getAmountOut = async (amountIn, aToB) => {
  const [reserveIn, reserveOut] = aToB
    ? await Promise.all([tokenA.balanceOf(pairAddress), tokenB.balanceOf(pairAddress)])
    : await Promise.all([tokenB.balanceOf(pairAddress), tokenA.balanceOf(pairAddress)]);
  const amountInWithFee = amountIn.muln(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.muln(1000).add(amountInWithFee);
  return numerator.div(denominator);
};

contract("UniswapV2Broker", function (accounts) {
  const deployer = accounts[0];
  const trader = accounts[1];
  before(async () => {
    const WETH = await WETH9.new();
    // deploy Uniswap V2 Factory & router.
    factory = await createContractObjectFromJson(UniswapV2Factory).new(deployer, { from: deployer });
    router = await createContractObjectFromJson(UniswapV2Router02).new(factory.address, WETH.address, {
      from: deployer,
    });

    // create a uniswapV2Broker
    uniswapV2Broker = await UniswapV2Broker.new();
  });
  beforeEach(async () => {
    // deploy tokens
    tokenA = await Token.new("TokenA", "TA", 18);
    tokenB = await Token.new("TokenB", "TB", 18);

    await tokenA.addMember(1, deployer, { from: deployer });
    await tokenB.addMember(1, deployer, { from: deployer });

    await tokenA.mint(trader, toWei("100000000000000"));
    await tokenB.mint(trader, toWei("100000000000000"));

    await tokenA.approve(router.address, toWei("100000000000000"), { from: trader });
    await tokenB.approve(router.address, toWei("100000000000000"), { from: trader });
    await tokenA.approve(uniswapV2Broker.address, MAX_UINT_VAL, { from: trader });
    await tokenB.approve(uniswapV2Broker.address, MAX_UINT_VAL, { from: trader });

    // initialize the pair
    await factory.createPair(tokenA.address, tokenB.address, { from: deployer });
    pairAddress = await factory.getPair(tokenA.address, tokenB.address);
    pair = await createContractObjectFromJson(IUniswapV2Pair).at(pairAddress);

    // For these test, say the synthetic starts trading at uniswap at 1000 TokenA/TokenB. To set this up we will seed the
    // pair with 1000x units of TokenA, relative to TokenB.
    await tokenA.mint(pairAddress, toBN(toWei("1000")).muln(10000000));
    await tokenB.mint(pairAddress, toBN(toWei("1")).muln(10000000));
    await pair.sync({ from: deployer });
    assert.equal(await getPoolSpotPrice(), "1000.0000"); // price should be exactly 1000 TokenA/TokenB.
  });

  it("Broker can correctly trade the price up to a desired price", async function () {
    // Say that someone comes and trades in size against the pool, trading a large amount of tokenB for tokenA,
    // dropping the token price to something off peg. We will compute that the price changes as expected. Say a trade of
    // 100000 token B for token A. Based on the pool size, the resultant price will be 980.3252 (see logic below for calc).
    const tradeSizeInTokenB = toBN(toWei("100000"));

    // Find how many tokens will be outputted for an input size of 100000 token B. We are adding token B, to get A. aToB
    // is false as we are trading from B -> A.
    const amountOut = await getAmountOut(tradeSizeInTokenB, false);

    // Find the modified versions of the token reservers. As we are trading token B for token A the A reservers should be
    // decreased by the amountOut and the token B reservers should be increased by the trade size in token B.
    const tokenAReserve = (await tokenA.balanceOf(pairAddress)).sub(amountOut);
    const tokenBReserve = (await tokenB.balanceOf(pairAddress)).add(tradeSizeInTokenB);

    // Compute the expected spot price from the two token reserves.
    const expectedSpotPrice = Number(fromWei(tokenAReserve.mul(toBN(toWei("1"))).div(tokenBReserve))).toFixed(4);

    // Execute the swap.
    await router.swapExactTokensForTokens(
      tradeSizeInTokenB, // amountIn. We are selling tokenB for tokenA, therefore tokenB is "in" and tokenB is "out"
      0, // amountOutMin
      [tokenB.address, tokenA.address], // path. We are trading from tokenB to tokenA (selling B for A)
      trader, // recipient of the trade
      (await web3.eth.getBlock("latest")).timestamp + 10, // deadline
      { from: trader }
    );
    assert.equal(await getPoolSpotPrice(), expectedSpotPrice);
    assert.equal(await getPoolSpotPrice(), "980.3252");

    // Now that the token is trading out off peg we can test that the broker can correctly trade it back to parity.
    // First, lets double check the bot calculates the correct trade size with the computeTradeToMoveMarket method.
    const tradeToMoveMarket = await uniswapV2Broker.computeTradeToMoveMarket(
      "1000", // the true price is represented as truePriceTokenA/truePriceTokenB.
      "1",
      await tokenA.balanceOf(pairAddress),
      await tokenB.balanceOf(pairAddress)
    );

    // For starters, to move the price UP we need to trade token A into the pool for token B. Therefore the aToB should
    // be true as the token flow should be A for token B to increase the price.
    assert.isTrue(tradeToMoveMarket.aToB);

    // Secondly, the resultant price after the trade based off the amountIn should be equal to the desired true price.
    const amountOutArb = await getAmountOut(tradeToMoveMarket.amountIn, tradeToMoveMarket.aToB);

    // Find the modified versions of the token reservers. As we are trading token A for token B the B reservers should be
    // decreased by the amountOut and the token A reservers should be increased by the trade size in token A.
    const tokenAReserveArb = (await tokenA.balanceOf(pairAddress)).add(tradeToMoveMarket.amountIn);
    const tokenBReserveArb = (await tokenB.balanceOf(pairAddress)).sub(amountOutArb);

    // Compute the expected spot price from the two token reserves. This should equal 1000, the desired "true" price.
    const postArbSpotPrice = Number(fromWei(tokenAReserveArb.mul(toBN(toWei("1"))).div(tokenBReserveArb))).toFixed(0);
    assert.equal(postArbSpotPrice, "1000");

    // Now we can actually execute the swapToPrice method to ensure that the contract correctly modifies the spot price.
    await uniswapV2Broker.swapToPrice(
      true, // The swap is being executed as an EOA. This ensures that the correct token transfers are done.
      router.address,
      factory.address,
      [tokenA.address, tokenB.address],
      ["1000", "1"], // The "true" price of the pair is expressed as the ratio of token A to token B. A price of 1000 is simply 1000/1.
      [MAX_UINT_VAL, MAX_UINT_VAL], // Set to the max posable value as we want to let the broker trade as much as needed in this example.
      trader,
      (await web3.eth.getBlock("latest")).timestamp + 10,
      { from: trader }
    );
    // The spot price should be within a fraction of a % of the desired price of 1000 TokenA/TokenB price. Some small
    // error may have been introduced due to how the babylonian method computes square roots in solidity.
    assert.equal(Number((await getPoolSpotPrice()).toString()).toFixed(0), "1000");
  });

  it("Broker can correctly trade the price down to a desired price", async function () {
    // Say that someone comes and trades in size against the pool, trading a large amount of tokenA for tokenB,
    // increasing the token price to something off peg. We will compute that the price changes as expected. Say a trade of
    // 1000000000 token A for token B. Based on the pool size, the resultant price will be 1209.6700 (see logic below for calc).
    const tradeSizeInTokenA = toBN(toWei("1000000000"));

    // Find how many tokens will be outputted for an input size of 100000 token B. We are adding token B, to get A. aToB
    // is true as we are trading from A -> B.
    const amountOut = await getAmountOut(tradeSizeInTokenA, true);

    // Find the modified versions of the token reservers. As we are trading token A for token B the B reservers should be
    // decreased by the amountOut and the token A reservers should be increased by the trade size in token A.
    const tokenAReserve = (await tokenA.balanceOf(pairAddress)).add(tradeSizeInTokenA);
    const tokenBReserve = (await tokenB.balanceOf(pairAddress)).sub(amountOut);

    // Compute the expected spot price from the two token reserves.
    const expectedSpotPrice = Number(fromWei(tokenAReserve.mul(toBN(toWei("1"))).div(tokenBReserve))).toFixed(4);

    // Execute the swap.
    await router.swapExactTokensForTokens(
      tradeSizeInTokenA, // amountIn. We are selling tokenA for tokenB, therefore tokenA is "in" and tokenB is "out"
      0, // amountOutMin
      [tokenA.address, tokenB.address], // path. We are trading from tokenA to tokenB (selling A for B)
      trader, // recipient of the trade
      (await web3.eth.getBlock("latest")).timestamp + 10, // deadline
      { from: trader }
    );
    assert.equal(await getPoolSpotPrice(), expectedSpotPrice);
    assert.equal(await getPoolSpotPrice(), "1209.6700");

    // Now that the token is trading out off peg we can test that the broker can correctly trade it back to parity.
    // First, lets double check the bot calculates the correct trade size with the computeTradeToMoveMarket method.
    const tradeToMoveMarket = await uniswapV2Broker.computeTradeToMoveMarket(
      "1000", // the true price is represented as truePriceTokenA/truePriceTokenB.
      "1",
      await tokenA.balanceOf(pairAddress),
      await tokenB.balanceOf(pairAddress)
    );

    // For starters, to move the price DOWN we need to trade token B into the pool for token A. Therefore the aToB should
    // be false as the token flow should be B for token A to increase the decrease.
    assert.isFalse(tradeToMoveMarket.aToB);

    // Secondly, the resultant price after the trade based off the amountIn should be equal to the desired true price.
    const amountOutArb = await getAmountOut(tradeToMoveMarket.amountIn, tradeToMoveMarket.aToB);

    // Find the modified versions of the token reservers. As we are trading token B for token A the A reservers should be
    // decreased by the amountOut and the token B reservers should be increased by the trade size in token B.
    const tokenAReserveArb = (await tokenA.balanceOf(pairAddress)).sub(amountOutArb);
    const tokenBReserveArb = (await tokenB.balanceOf(pairAddress)).add(tradeToMoveMarket.amountIn);

    // Compute the expected spot price from the two token reserves. This should equal 1000, the desired "true" price.
    const postArbSpotPrice = Number(fromWei(tokenAReserveArb.mul(toBN(toWei("1"))).div(tokenBReserveArb))).toFixed(0);
    assert.equal(postArbSpotPrice, "1000");

    // Now we can actually execute the swapToPrice method to ensure that the contract correctly modifies the spot price.
    await uniswapV2Broker.swapToPrice(
      true, // The swap is being executed as an EOA. This ensures that the correct token transfers are done.
      router.address,
      factory.address,
      [tokenA.address, tokenB.address],
      ["1000", "1"], // The "true" price of the pair is expressed as the ratio of token A to token B. A price of 1000 is simply 1000/1.
      [MAX_UINT_VAL, MAX_UINT_VAL], // Set to the max posable value as we want to let the broker trade as much as needed in this example.
      trader,
      (await web3.eth.getBlock("latest")).timestamp + 10,
      { from: trader }
    );
    // The spot price should be within a fraction of a % of the desired price of 1000 TokenA/TokenB price. Some small
    // error may have been introduced due to how the babylonian method computes square roots in solidity.
    assert.equal(Number((await getPoolSpotPrice()).toString()).toFixed(0), "1000");
  });
});
