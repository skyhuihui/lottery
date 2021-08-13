const { expect } = require(`chai`);
const { BigNumber } = require("ethers");
const { ethers, network} = require(`hardhat`);
const {use} = require("chai");

let accounts,owner, bswToken, oracle, rng, lottery;
let bracketCalculator = [];
before(async function(){
    accounts = await ethers.getSigners();
    owner = accounts[0];
    const BSWToken = await ethers.getContractFactory(`BSWToken`);
    bswToken = await BSWToken.deploy();
    await bswToken.deployed();

    const Oracle = await ethers.getContractFactory(`TestOracle`);
    oracle = await Oracle.deploy();
    await oracle.deployed();

    const Rng = await ethers.getContractFactory(`TestRandomNumberGenerator`);
    rng = await Rng.deploy();
    await rng.deployed();

    const Lottery = await ethers.getContractFactory(`BiswapLottery`);
    lottery = await Lottery.deploy(bswToken.address, bswToken.address, rng.address, oracle.address);
    await lottery.deployed();

    await lottery.setManagingAddresses(owner.address, owner.address, owner.address, accounts[1].address, accounts[2].address);
    await rng.setLotteryAddress(lottery.address);

    bracketCalculator[0] = 1;
    bracketCalculator[1] = 11;
    bracketCalculator[2] = 111;
    bracketCalculator[3] = 1111;
    bracketCalculator[4] = 11111;
    bracketCalculator[5] = 111111;
});
// await network.provider.send("evm_mine");
// await network.provider.send("evm_setNextBlockTimestamp", [1625097600])
// await network.provider.send("evm_increaseTime", [3600])

function getBracketsForTickets(ticketsIds, ticketsNumbers, winNumber){
    let transfWinNumber, transfTicketsNumber;
    let winTicketsId = new Map();
    for(let i = 0; i < ticketsNumbers.length; i++){
        transfWinNumber = 0;
        transfTicketsNumber = 0;
        for(let j = 0; j < bracketCalculator.length; j++){
            transfWinNumber = bracketCalculator[j] + (winNumber % (10**(j+1)));
            transfTicketsNumber = bracketCalculator[j] + (ticketsNumbers[i] % (10**(j+1)));
            if (transfWinNumber === transfTicketsNumber){
                winTicketsId.set(ticketsIds[i], j);
            } else {
                break;
            }
        }
    }
    // Map(key: ticketId, value: bracket)
    return winTicketsId;
}

function getCountTicketsOnBrackets(ticketsNumbers, winningNumber, rewardsBreakdown, amountCollectedInBSW){
    let bswPerBracket = [];
    let countTicketsPerBracket = [];
    let ticketsOnBrackets = new Map();
    let amountToInjectNextLottery = 0;
    ticketsOnBrackets.constructor.prototype.increment = function (key) {
        this.has(key) ? this.set(key, this.get(key) + 1) : this.set(key, 1);
    }
    for(let i = 0;i < ticketsNumbers.length; i++){
        if(ticketsNumbers[i] < 1000000 || ticketsNumbers[i] > 1999999){
            console.log('Wrong ticket number', ticketsNumbers[i]);
            return 0;
        }
        for(let j = 0; j < 6; j++){
        ticketsOnBrackets.increment(bracketCalculator[j] + ticketsNumbers[i] % 10**(j+1));
        }
    }
    let previousCount = 0;
    for(let i = 5; i>=0; i--){
        let transfWinningNumber = bracketCalculator[i] + (winningNumber % 10**(i+1));
        countTicketsPerBracket[i] = (ticketsOnBrackets.get(transfWinningNumber) - previousCount) || 0;

        if(countTicketsPerBracket[i] > 0){
            if(rewardsBreakdown[i] > 0){
                bswPerBracket[i] = ((amountCollectedInBSW.mul(rewardsBreakdown[i])).div(countTicketsPerBracket[i])).div(10000);
                previousCount = ticketsOnBrackets.get(transfWinningNumber);
            }
        } else {
            bswPerBracket[i] = 0;
            amountToInjectNextLottery += (rewardsBreakdown[i] * amountCollectedInBSW) / 10000;
        }
    }
    return [bswPerBracket, countTicketsPerBracket, amountToInjectNextLottery];
}

describe(`Check start new lottery`, function () {
    let endTime, ticketsNumbers, burningShare, competitionAndRefShare;
    let rewardsBreakdown = [250, 375, 625, 1250, 2500, 5000];
    let priceTicketInUSDT = BigNumber.from(`1000000000000000000`);
    let discountDivisor = 10000;

    it(`Start new lottery`, async function () {
        const timeLastBlock = (await ethers.provider.getBlock(`latest`)).timestamp;
        endTime = timeLastBlock + 14400; //after 4 hours
        await expect(lottery.startLottery(endTime, priceTicketInUSDT, discountDivisor, rewardsBreakdown)).to.be //(uint256 _endTime, uint256 _priceTicketInUSDT, uint256 _discountDivisor, uint256[6] calldata _rewardsBreakdown})
            .emit(lottery, 'LotteryOpen');
        console.log(`Lottery start. Current lottery id: `, (await lottery.currentLotteryId()).toString());
    });

    it(`Buy tickets and check transfers amounts`, async function () {
        //                  1853548  1853548  1853548 1903507
        ticketsNumbers = [1275708, 1379708, 1219701, 1271608, 1279101, 1279101];
        let currentPriceInBSW = await lottery.getCurrentTicketPriceInBSW(lottery.currentLotteryId());
        let balanceLotteryBefore = await bswToken.balanceOf(lottery.address);
        let totalAmountForTickets = currentPriceInBSW.mul(ticketsNumbers.length)
            .mul(discountDivisor + 1 - ticketsNumbers.length).div(discountDivisor);
        await bswToken.approve(lottery.address, totalAmountForTickets);
        await expect(lottery.buyTickets(1, ticketsNumbers)).to.be.emit(lottery, `TicketsPurchase`);
        let balanceLotteryAfter = await bswToken.balanceOf(lottery.address);
        expect(balanceLotteryAfter.sub(balanceLotteryBefore)).equal(totalAmountForTickets);
    });

    it(`Check close lottery`, async function () {
        await network.provider.send("evm_setNextBlockTimestamp", [endTime + 1]);
        await expect(lottery.closeLottery(1)).to.be.emit(lottery, `LotteryClose`);
        let randomResult = await rng.viewRandomResult();
        let amountCollectedInBSW = (await lottery.viewLottery(1)).amountCollectedInBSW;
        burningShare = await lottery.burningShare();
        competitionAndRefShare = await lottery.competitionAndRefShare();
        let amountToDistribute = amountCollectedInBSW.sub(amountCollectedInBSW.div(10000).mul(burningShare.add(competitionAndRefShare)))
        let calculateBrackets = getCountTicketsOnBrackets(ticketsNumbers, randomResult, rewardsBreakdown, amountToDistribute);
        await expect(lottery.drawFinalNumberAndMakeLotteryClaimable(1, calculateBrackets[0], calculateBrackets[1], true))
            .to.be.emit(lottery, `LotteryNumberDrawn`)
        expect(amountCollectedInBSW.div(10000).mul(burningShare.add(competitionAndRefShare)))
            .to.equal((await bswToken.balanceOf(accounts[1].address)).add(await bswToken.balanceOf(accounts[2].address)));
        let viewLottery = await lottery.viewLottery(1);

        console.log("Amount collected in BSW", amountCollectedInBSW)
        console.log("Amount burn referrals and competitions", (amountCollectedInBSW.sub(amountToDistribute)).toString());
        console.log("Winning number: ", viewLottery.finalNumber.toString());
        console.log("Winning amount per bracket: ", viewLottery.bswPerBracket.toString());
        console.log("Count winners per bracket: ", viewLottery.countWinnersPerBracket.toString());
        console.log("Contract balance: ", (await bswToken.balanceOf(lottery.address)).toString());
        console.log("Injection to next lottery: ", (await lottery.pendingInjectionNextLottery()).toString());
    });

    it(`Check winning number and claimed ticket`, async function () {
        let viewLottery = await lottery.viewLottery(1);
        let finalNumber = viewLottery.finalNumber;
        let userInfoForLotId = await lottery.viewUserInfoForLotteryId(owner.address, 1, 0, 100)
        ticketsNumbers = userInfoForLotId[1];
        let ticketsIds = userInfoForLotId[0];
        let brackets = getBracketsForTickets(ticketsIds, ticketsNumbers, finalNumber);
        let winTicketId = Array.from(brackets.keys());
        let winBrackets = Array.from(brackets.values());

        await lottery.claimTickets(1, winTicketId, winBrackets);
        expect(await bswToken.balanceOf(lottery.address)).equal(await lottery.pendingInjectionNextLottery());
    });
});
describe(`Chek start new lottery and inject from previous lottery`, function(){

    it('Chek start new lottery', async function (){
        const timeLastBlock = (await ethers.provider.getBlock(`latest`)).timestamp;
        endTime = timeLastBlock + 14400; //after 4 hours
        await expect(lottery.startLottery(endTime, priceTicketInUSDT, discountDivisor, rewardsBreakdown)).to.be
            .emit(lottery,'LotteryOpen');
        let currentLottery = await lottery.viewLottery(await lottery.currentLotteryId());
        expect(currentLottery.amountCollectedInBSW).equal(await bswToken.balanceOf(lottery.address));
        expect(await lottery.pendingInjectionNextLottery()).equal(0);
        console.log(`Lottery start. Current lottery id: `, (await lottery.currentLotteryId()).toString());
    })

    it('Check buy 500 tickets from 1 transaction', async function (){
        ticketsNumbers = Array.from(Array(200),
            () => (Math.floor(Math.random() * (1999999 - 1000000 + 1)) + 1000000));
        await lottery.setMaxNumberTicketsPerBuy(500);
        let balanceLotteryBefore = await bswToken.balanceOf(lottery.address);
        let currentPriceInBSW = await lottery.getCurrentTicketPriceInBSW(lottery.currentLotteryId());
        let totalAmountForTickets = lottery.calculateTotalPriceForBulkTickets(10000, currentPriceInBSW, ticketsNumbers.length);
        await bswToken.approve(lottery.address, totalAmountForTickets);
        await expect(lottery.buyTickets(lottery.currentLotteryId(), ticketsNumbers))
            .to.be.emit(lottery, `TicketsPurchase`);
        let balanceLotteryAfter = await bswToken.balanceOf(lottery.address);
        console.log(balanceLotteryBefore.toString(), balanceLotteryAfter.toString());
    });
//TODO chek claim same ticket 2 times,
// check withdraw injection sum after lottery finished,
// check claim ticket from different accounts,
// check change burn and competitions fee,
// chek change price
})