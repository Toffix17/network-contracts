// Copyright (C) 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers, waffle } from 'hardhat';
import {
    EraManager,
    ERC20,
    IndexerRegistry,
    PlanManager,
    ProjectRegistry,
    RewardsDistributor,
    RewardsHelper,
    RewardsStaking,
    Staking,
    StakingManager,
} from '../src';
import { DEPLOYMENT_ID, METADATA_HASH, VERSION } from './constants';
import { acceptPlan, addInstantRewards, etherParse, eventFrom, startNewEra, time, timeTravel } from './helper';
import { deployContracts } from './setup';

describe('RewardsDistributor Contract', () => {
    let root, runner, consumer, delegator, delegator2;

    let token: ERC20;
    let staking: Staking;
    let stakingManager: StakingManager;
    let projectRegistry: ProjectRegistry;
    let indexerRegistry: IndexerRegistry;
    let planManager: PlanManager;
    let eraManager: EraManager;
    let rewardsDistributor: RewardsDistributor;
    let rewardsStaking: RewardsStaking;
    let rewardsHelper: RewardsHelper;

    //rewrite registerIndexer to registe indexer with stakeAmount and commissionRate
    const registerIndexer = async (rootWallet, wallet, amount, rate) => {
        await token.connect(rootWallet).transfer(wallet.address, amount);
        await token.connect(wallet).increaseAllowance(staking.address, amount);
        await indexerRegistry.connect(wallet).registerIndexer(amount, METADATA_HASH, rate, { gasLimit: '2000000' });
    };

    const checkValues = async (_indexerBalance, _delegatorBalance, _totalStakingAmount, _eraReward) => {
        expect(await token.balanceOf(runner.address)).to.be.equal(_indexerBalance);
        expect(await token.balanceOf(delegator.address)).to.be.equal(_delegatorBalance);
        expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.equal(_totalStakingAmount);
        expect((await rewardsDistributor.getRewardInfo(runner.address)).eraReward).to.be.equal(_eraReward);
    };

    const travelEraAndCollect = async (signer, eras: number): Promise<BigNumber> => {
        const balanceBefore = await token.balanceOf(signer.address);
        for (let i = 0; i < eras; i++) {
            await startNewEra(eraManager);
            await rewardsHelper.connect(signer).indexerCatchup(signer.address);
        }
        await rewardsDistributor.connect(signer).claim(signer.address);
        const balanceAfter = await token.balanceOf(signer.address);
        return balanceAfter.sub(balanceBefore);
    };

    const withdrawAllUnbondReq = async (signer): Promise<BigNumber> => {
        const balanceBefore = await token.balanceOf(signer.address);
        await stakingManager.connect(signer).widthdraw();
        const balanceAfter = await token.balanceOf(signer.address);
        return balanceAfter.sub(balanceBefore);
    };

    const runnerInitialStake = etherParse('1000');
    const runnerCr = BigNumber.from(1e5);
    const eraPeriod = time.duration.days(5).toNumber();

    const deployer = () => deployContracts(root, runner);
    before(async () => {
        [root, runner, consumer, delegator, delegator2] = await ethers.getSigners();
    });

    beforeEach(async () => {
        const deployment = await waffle.loadFixture(deployer);
        indexerRegistry = deployment.indexerRegistry;
        projectRegistry = deployment.projectRegistry;
        planManager = deployment.planManager;
        staking = deployment.staking;
        stakingManager = deployment.stakingManager;
        token = deployment.token;
        rewardsDistributor = deployment.rewardsDistributor;
        rewardsStaking = deployment.rewardsStaking;
        rewardsHelper = deployment.rewardsHelper;
        eraManager = deployment.eraManager;

        //init delegator account
        await token.connect(root).transfer(delegator.address, etherParse('10'));
        await token.connect(root).transfer(delegator2.address, etherParse('10'));
        await token.connect(root).transfer(consumer.address, etherParse('10'));
        await token.connect(consumer).increaseAllowance(planManager.address, etherParse('10000'));
        await token.connect(delegator).increaseAllowance(staking.address, etherParse('10000'));
        await token.connect(delegator2).increaseAllowance(staking.address, etherParse('10000'));
        await token.connect(root).increaseAllowance(rewardsDistributor.address, etherParse('10000'));

        //setup era period be 5 days
        await eraManager.connect(root).updateEraPeriod(eraPeriod);
        //register an new Indexer with Initial Commission Rate: 10% and Initial Staking Amount: 1000
        //moved to era 2
        await registerIndexer(root, runner, runnerInitialStake, runnerCr);
        await registerIndexer(root, root, runnerInitialStake, runnerCr);
        await projectRegistry.createProject(METADATA_HASH, VERSION, DEPLOYMENT_ID, 0);
        // wallet_0 start project
        await projectRegistry.connect(runner).startService(DEPLOYMENT_ID);
        await projectRegistry.connect(root).startService(DEPLOYMENT_ID);
    });

    describe('initialization', async () => {
        it('rewardsDistributor contract should initialize correctly', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
        });

        it('commissionRates and stakingAmount of new indexer should be load to rewardsDistributor contract', async () => {
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(1e5);
            expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.eq(etherParse('1000'));
        });
    });

    describe('Rewards Split In Eras', async () => {
        beforeEach(async () => {
            await staking.setLockPeriod(0);
            await staking.setUnbondFeeRateBP(0);
        });
        it('split rewards into 1 eras should work', async () => {
            // accept agreement of 5 days period, value 3 SQT
            const agreementValue = etherParse('3');
            await acceptPlan(runner, consumer, 2, agreementValue, DEPLOYMENT_ID, token, planManager);
            const currentEra = await (await eraManager.eraNumber()).toNumber();
            const rewardsAddTable = await rewardsHelper.getRewardsAddTable(runner.address, currentEra, 3);
            const rewardsRemoveTable = await rewardsHelper.getRewardsRemoveTable(runner.address, currentEra, 3);
            const rewardsAdd = rewardsAddTable.reduce((acc, val) => acc.add(val), BigNumber.from(0));
            const rewardsRemove = rewardsRemoveTable.reduce((acc, val) => acc.add(val), BigNumber.from(0));
            expect(rewardsAdd.sub(rewardsRemove)).to.eq(0);
            expect(rewardsRemoveTable[2]).to.eq(0);
            expect(rewardsAddTable[2]).to.eq(0);
            const [eraReward, totalReward] = rewardsAddTable.reduce(
                (acc, val, idx) => {
                    let eraReward = acc[0];
                    const total = acc[1];
                    eraReward = eraReward.add(val.sub(rewardsRemoveTable[idx]));
                    expect(eraReward.isNegative()).to.be.false;
                    return [eraReward, total.add(eraReward)];
                },
                [BigNumber.from(0), BigNumber.from(0)]
            );
            expect(eraReward).to.be.eq(0);
            expect(totalReward).to.be.eq(agreementValue);

            const claimed = await travelEraAndCollect(runner, 3);
            const commission = await withdrawAllUnbondReq(runner);
            expect(totalReward.mul(runnerCr).div(1e6).sub(commission)).to.lte(10);
            expect(totalReward.sub(claimed.add(commission))).to.lte(10);
        });
        it('split rewards into 2 eras should work', async () => {
            // accept agreement of 5 days period, value 3 SQT
            const agreementValue = etherParse('3');
            await timeTravel(1000);
            await acceptPlan(runner, consumer, 5, agreementValue, DEPLOYMENT_ID, token, planManager);
            const currentEra = await (await eraManager.eraNumber()).toNumber();
            const rewardsAddTable = await rewardsHelper.getRewardsAddTable(runner.address, currentEra, 4);
            const rewardsRemoveTable = await rewardsHelper.getRewardsRemoveTable(runner.address, currentEra, 4);
            const rewardsAdd = rewardsAddTable.reduce((acc, val) => acc.add(val), BigNumber.from(0));
            const rewardsRemove = rewardsRemoveTable.reduce((acc, val) => acc.add(val), BigNumber.from(0));
            expect(rewardsAdd.sub(rewardsRemove)).to.eq(0);
            expect(rewardsRemoveTable[3]).to.eq(0);
            expect(rewardsAddTable[3]).to.eq(0);
            const [eraReward, totalReward] = rewardsAddTable.reduce(
                (acc, val, idx) => {
                    let eraReward = acc[0];
                    const total = acc[1];
                    eraReward = eraReward.add(val.sub(rewardsRemoveTable[idx]));
                    expect(eraReward.isNegative()).to.be.false;
                    return [eraReward, total.add(eraReward)];
                },
                [BigNumber.from(0), BigNumber.from(0)]
            );
            expect(eraReward).to.be.eq(0);
            expect(totalReward).to.be.eq(agreementValue);
            const claimed = await travelEraAndCollect(runner, 4);
            const commission = await withdrawAllUnbondReq(runner);
            expect(totalReward.mul(runnerCr).div(1e6).sub(commission)).to.lte(1e10);
            expect(totalReward.sub(claimed.add(commission))).to.lte(1e10);
        });

        it('split rewards into eras should work', async () => {
            const agreementValue = etherParse('3');
            await acceptPlan(runner, consumer, 30, agreementValue, DEPLOYMENT_ID, token, planManager);
            const currentEra = (await eraManager.eraNumber()).toNumber();

            expect(await token.balanceOf(rewardsDistributor.address)).to.be.eq(agreementValue);

            const rewardsAddTable = await rewardsHelper.getRewardsAddTable(runner.address, currentEra, 9);
            const rewardsRemoveTable = await rewardsHelper.getRewardsRemoveTable(runner.address, currentEra, 9);
            const [eraReward, totalReward] = rewardsAddTable.reduce(
                (acc, val, idx) => {
                    let eraReward = acc[0];
                    const total = acc[1];
                    eraReward = eraReward.add(val.sub(rewardsRemoveTable[idx]));
                    console.log(`eraReward: ${idx}, ${eraReward.toString()}`);
                    expect(eraReward.isNegative()).to.be.false;
                    return [eraReward, total.add(eraReward)];
                },
                [BigNumber.from(0), BigNumber.from(0)]
            );
            expect(eraReward).to.be.eq(0);
            expect(totalReward).to.be.eq(agreementValue);

            const claimed = await travelEraAndCollect(runner, 9);
            const commission = await withdrawAllUnbondReq(runner);
            expect(totalReward.mul(runnerCr).div(1e6).sub(commission)).to.lte(1e10);
            expect(totalReward.sub(claimed.add(commission))).to.lte(1e10);
            //499986111111111111, 13888888888889
            //499987268518518518+499987268518518518
        });
    });

    describe('Rewards Split Amongst Operator & Delegators', () => {
        // runner stake: 1000
        // delegation: 9000
        const runnerStake = etherParse(1000);
        const delegation1 = etherParse(4000);
        const delegation2 = etherParse(5000);
        beforeEach(async () => {
            await staking.setIndexerLeverageLimit(20);
            await token.transfer(delegator.address, delegation1);
            await token.connect(delegator).increaseAllowance(staking.address, delegation1);
            await stakingManager.connect(delegator).delegate(runner.address, delegation1);
            await token.transfer(delegator2.address, delegation2);
            await token.connect(delegator2).increaseAllowance(staking.address, delegation2);
            await stakingManager.connect(delegator2).delegate(runner.address, delegation2);
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);
            const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            expect(totalStake).to.eq(runnerStake.add(delegation1).add(delegation2));
        });
        // weight,
        const scens = [[undefined], [2e6], [1e7]];

        for (const [idx, [_weight]] of scens.entries()) {
            it(`rewards split with weight #${idx}`, async () => {
                const weight = (_weight ?? 1e6) / 1e6;
                if (_weight) {
                    await rewardsStaking.setRunnerStakeWeight(_weight);
                }
                const era = await eraManager.eraNumber();
                await addInstantRewards(token, rewardsDistributor, root, runner.address, era, etherParse('1000'));
                await startNewEra(eraManager);
                const tx = await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
                const { rewards, commission } = await eventFrom(
                    tx,
                    rewardsDistributor,
                    'DistributeRewards(address,uint256,uint256,uint256)'
                );
                const sharedRewards = rewards.sub(commission);
                const runnerRewards = await rewardsDistributor.userRewards(runner.address, runner.address);
                const delegatorRewards1 = await rewardsDistributor.userRewards(runner.address, delegator.address);
                const delegatorRewards2 = await rewardsDistributor.userRewards(runner.address, delegator2.address);
                const totalStakeWeighted = await rewardsStaking.getTotalStakingAmount(runner.address);
                const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
                const runnerStakeWeighted = await rewardsStaking.getDelegationAmount(runner.address, runner.address);
                expect(runnerStakeWeighted).to.eq(runnerStake.mul(weight));
                expect(totalStakeWeighted).to.eq(totalStake.add(runnerStake.mul(weight - 1)));
                expect(sharedRewards.sub(runnerRewards.add(delegatorRewards1).add(delegatorRewards2))).to.lte(2e10);
                expect(totalStakeWeighted).to.eq(runnerStake.mul(weight).add(delegation1).add(delegation2));
                expect(runnerStake.mul(weight).mul(sharedRewards).div(totalStakeWeighted).sub(runnerRewards)).to.lte(
                    2e10
                );
            });
        }

        it('weight increase', async () => {
            //  from 2e6 to 3e6
            const _prevWeight = 2e6;
            const prevWeight = _prevWeight / 1e6;
            const _postWeight = 3e6;
            const postWeight = _postWeight / 1e6;
            await rewardsStaking.setRunnerStakeWeight(_prevWeight);
            await startNewEra(eraManager);
            await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            await rewardsStaking.setRunnerStakeWeight(_postWeight);
            const era = await eraManager.eraNumber();
            await addInstantRewards(token, rewardsDistributor, root, runner.address, era, etherParse('1000'));
            await startNewEra(eraManager);
            const tx = await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            const { rewards, commission } = await eventFrom(
                tx,
                rewardsDistributor,
                'DistributeRewards(address,uint256,uint256,uint256)'
            );
            const sharedRewards = rewards.sub(commission);
            const runnerRewards = await rewardsDistributor.userRewards(runner.address, runner.address);
            const delegatorRewards1 = await rewardsDistributor.userRewards(runner.address, delegator.address);
            const delegatorRewards2 = await rewardsDistributor.userRewards(runner.address, delegator2.address);
            const totalStakeWeighted = await rewardsStaking.getTotalStakingAmount(runner.address);
            const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            const runnerStakeWeighted = await rewardsStaking.getDelegationAmount(runner.address, runner.address);
            expect(runnerStakeWeighted).to.eq(runnerStake.mul(postWeight));
            expect(totalStakeWeighted).to.eq(totalStake.add(runnerStake.mul(postWeight - 1)));
            expect(sharedRewards.sub(runnerRewards.add(delegatorRewards1).add(delegatorRewards2))).to.lte(2e10);
            expect(totalStakeWeighted).to.eq(runnerStake.mul(postWeight).add(delegation1).add(delegation2));
            expect(runnerStake.mul(postWeight).mul(sharedRewards).div(totalStakeWeighted).sub(runnerRewards)).to.lte(
                2e10
            );
        });

        it('weight drop', async () => {
            //  from 3e6 to 1e6
            const _prevWeight = 3e6;
            const prevWeight = _prevWeight / 1e6;
            const _postWeight = 1e6;
            const postWeight = _postWeight / 1e6;
            await rewardsStaking.setRunnerStakeWeight(_prevWeight);
            await startNewEra(eraManager);
            await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            await rewardsStaking.setRunnerStakeWeight(_postWeight);
            const era = await eraManager.eraNumber();
            await addInstantRewards(token, rewardsDistributor, root, runner.address, era, etherParse('1000'));
            await startNewEra(eraManager);
            const tx = await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            const { rewards, commission } = await eventFrom(
                tx,
                rewardsDistributor,
                'DistributeRewards(address,uint256,uint256,uint256)'
            );
            const sharedRewards = rewards.sub(commission);
            const runnerRewards = await rewardsDistributor.userRewards(runner.address, runner.address);
            const delegatorRewards1 = await rewardsDistributor.userRewards(runner.address, delegator.address);
            const delegatorRewards2 = await rewardsDistributor.userRewards(runner.address, delegator2.address);
            const totalStakeWeighted = await rewardsStaking.getTotalStakingAmount(runner.address);
            const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            const runnerStakeWeighted = await rewardsStaking.getDelegationAmount(runner.address, runner.address);
            expect(runnerStakeWeighted).to.eq(runnerStake.mul(postWeight));
            expect(totalStakeWeighted).to.eq(totalStake.add(runnerStake.mul(postWeight - 1)));
            expect(sharedRewards.sub(runnerRewards.add(delegatorRewards1).add(delegatorRewards2))).to.lte(2e10);
            expect(totalStakeWeighted).to.eq(runnerStake.mul(postWeight).add(delegation1).add(delegation2));
            expect(runnerStake.mul(postWeight).mul(sharedRewards).div(totalStakeWeighted).sub(runnerRewards)).to.lte(
                2e10
            );
        });

        it('delegation change', async () => {
            // runner stake: 1000 (x3)
            // delegation1: 4000 -> 6000
            // delegation2: 5000
            const _weight = 3e6;
            const weight = _weight / 1e6;
            await rewardsStaking.setRunnerStakeWeight(_weight);
            await startNewEra(eraManager);
            await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);

            let totalStakeWeighted = await rewardsStaking.getTotalStakingAmount(runner.address);
            let totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            let runnerStakeWeighted = await rewardsStaking.getDelegationAmount(runner.address, runner.address);
            const delegation1_0 = await rewardsStaking.getDelegationAmount(delegator.address, runner.address);
            expect(runnerStakeWeighted).to.eq(runnerStake.mul(weight));
            expect(totalStakeWeighted).to.eq(totalStake.add(runnerStake.mul(weight - 1)));
            expect(totalStakeWeighted).to.eq(runnerStake.mul(weight).add(delegation1).add(delegation2));
            expect(delegation1_0).to.eq(delegation1);
            // add more delegation
            const moreDelegation = etherParse(2000);
            await token.transfer(delegator.address, moreDelegation);
            await token.connect(delegator).increaseAllowance(staking.address, moreDelegation);
            await stakingManager.connect(delegator).delegate(runner.address, moreDelegation);
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);
            totalStakeWeighted = await rewardsStaking.getTotalStakingAmount(runner.address);
            totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            runnerStakeWeighted = await rewardsStaking.getDelegationAmount(runner.address, runner.address);
            const delegation1_1 = await rewardsStaking.getDelegationAmount(delegator.address, runner.address);
            expect(runnerStakeWeighted).to.eq(runnerStake.mul(weight));
            expect(totalStakeWeighted).to.eq(totalStake.add(runnerStake.mul(weight - 1)));
            expect(totalStakeWeighted).to.eq(
                runnerStake.mul(weight).add(delegation1).add(delegation2).add(moreDelegation)
            );
            expect(delegation1_1).to.eq(delegation1.add(moreDelegation));
        });
    });

    describe('Capped Rewards', async () => {
        beforeEach(async () => {
            await token.connect(root).transfer(runner.address, etherParse('10000'));
            await token.connect(root).transfer(delegator.address, etherParse('10000'));
            await token.connect(root).transfer(consumer.address, etherParse('10000'));
            await stakingManager.connect(delegator).delegate(runner.address, etherParse(9000));
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);
        });
        it('receive capped rewards', async () => {
            // self stake 1000 SQT
            // delegation: 9000 SQT
            // commission rate: 5%
            // reward cap: 10%
            // commission cap: 10%
            // arrival rewards: 1500 SQT
            await rewardsDistributor.setMaxCommissionFactor(5e4);
            await rewardsDistributor.setMaxRewardFactor(1e5);
            const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            expect(totalStake).to.eq(etherParse(10000));
            const selfStake = await stakingManager.getDelegationAmount(runner.address, runner.address);
            expect(selfStake).to.eq(etherParse(1000));
            const arrivalReward = etherParse(1500);
            const era = await eraManager.eraNumber();
            await addInstantRewards(token, rewardsDistributor, consumer, runner.address, era, arrivalReward);
            await startNewEra(eraManager);
            const tx = await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            const distributedRewards = await eventFrom(
                tx,
                rewardsDistributor,
                'DistributeRewards(address,uint256,uint256,uint256)'
            );
            expect(distributedRewards.rewards).to.eq(etherParse(1000));
            expect(distributedRewards.commission).to.eq(etherParse(50));
            const returnRewards = await eventFrom(tx, rewardsDistributor, 'ReturnRewards(address,uint256,uint256)');
            expect(returnRewards.rewards).to.eq(etherParse(500));
            expect(returnRewards.commission).to.eq(etherParse(100));
        });
        it('rewards after capped may become zero', async () => {
            // self stake 9000 SQT
            // delegation: 9000 SQT
            // commission rate: 30%
            // reward cap: 10%
            // commission cap: 25%
            // arrival rewards: 10000 SQT
            // commission: 3000 SQT
            // capped commission: 2250 SQT
            // capped reward: 1800 SQT
            await rewardsDistributor.setMaxCommissionFactor(2.5e5);
            await rewardsDistributor.setMaxRewardFactor(1e5);
            await token.connect(runner).increaseAllowance(staking.address, etherParse(8000));
            await stakingManager.connect(runner).stake(runner.address, etherParse(8000));
            await indexerRegistry.connect(runner).setCommissionRate(3e5);
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);

            const totalStake = await stakingManager.getTotalStakingAmount(runner.address);
            expect(totalStake).to.eq(etherParse(18000));
            const selfStake = await stakingManager.getDelegationAmount(runner.address, runner.address);
            expect(selfStake).to.eq(etherParse(9000));
            const arrivalReward = etherParse(10000);
            const era = await eraManager.eraNumber();
            await addInstantRewards(token, rewardsDistributor, consumer, runner.address, era, arrivalReward);
            await startNewEra(eraManager);
            const tx = await rewardsDistributor.connect(runner).collectAndDistributeRewards(runner.address);
            const distributedRewards = await eventFrom(
                tx,
                rewardsDistributor,
                'DistributeRewards(address,uint256,uint256,uint256)'
            );
            expect(distributedRewards.rewards).to.eq(etherParse(2250)); // exclude commission
            expect(distributedRewards.commission).to.eq(etherParse(2250));
            const returnRewards = await eventFrom(tx, rewardsDistributor, 'ReturnRewards(address,uint256,uint256)');
            expect(returnRewards.rewards).to.eq(etherParse(7750));
            expect(returnRewards.commission).to.eq(etherParse(750));
        });
    });

    describe('distribute and claim rewards', async () => {
        beforeEach(async () => {
            //a 30 days agreement with 400 rewards come in at Era2
            await acceptPlan(runner, consumer, 30, etherParse('3'), DEPLOYMENT_ID, token, planManager);
            await acceptPlan(root, consumer, 30, etherParse('3'), DEPLOYMENT_ID, token, planManager);
        });
        it('Rewards table be cleaned after collection', async () => {
            const startEra = (await eraManager.eraNumber()).toNumber();
            for (let i = 0; i < 12; i++) {
                await startNewEra(eraManager);
                await rewardsDistributor.collectAndDistributeRewards(runner.address);
                expect((await rewardsHelper.getRewardsAddTable(runner.address, startEra + i, 1))[0]).to.be.eq(
                    etherParse('0')
                );
                expect((await rewardsHelper.getRewardsRemoveTable(runner.address, startEra + i, 1))[0]).to.be.eq(
                    etherParse('0')
                );
            }
        });

        it('commission should add to unbond', async () => {
            await startNewEra(eraManager);
            const balance = await token.balanceOf(rewardsDistributor.address);
            const stakingBalance = await token.balanceOf(staking.address);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);

            const eventFilter = staking.filters.UnbondRequested();
            const evt = (await staking.queryFilter(eventFilter))[0];
            const unbondEvent = staking.interface.decodeEventLog(
                staking.interface.getEvent('UnbondRequested'),
                evt.data
            );

            expect(await token.balanceOf(rewardsDistributor.address)).to.be.eq(balance.sub(unbondEvent.amount));
            expect(await token.balanceOf(staking.address)).to.be.eq(stakingBalance.add(unbondEvent.amount));
            const unbond = await staking.unbondingAmount(runner.address, unbondEvent.index);
            expect(unbond.amount).to.be.eq(unbondEvent.amount);
            expect(unbondEvent._type).to.be.eq(2);
        });

        it('should be able to batch collect and distribute rewards', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            //move to Era5
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.batchCollectAndDistributeRewards(runner.address, 10);
            expect(await eraManager.eraNumber()).to.be.eq(5);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(4);
            await rewardsDistributor.connect(runner).claim(runner.address);
            // TODO: further investiget why the balance changed ?
            expect(await (await token.balanceOf(runner.address)).div(1e14)).to.be.eq(13499);
        });

        it('indexerCatchup with no pending change', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            //move to Era8
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            expect(await eraManager.eraNumber()).to.be.eq(8);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(7);
            expect(await rewardsStaking.getLastSettledEra(runner.address)).to.be.eq(7);
        });

        it('indexerCatchup with middle pending changes', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            //move to Era8
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('2'));
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            expect(await eraManager.eraNumber()).to.be.eq(8);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(7);
            expect(await rewardsStaking.getLastSettledEra(runner.address)).to.be.eq(7);
            expect((await rewardsHelper.getPendingStakers(runner.address)).length).to.be.eq(0);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
        });

        it('indexerCatchup with start pending changes', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('2'));
            await indexerRegistry.connect(runner).setCommissionRate(200);
            //move to Era8
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            expect(await eraManager.eraNumber()).to.be.eq(8);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(7);
            expect(await rewardsStaking.getLastSettledEra(runner.address)).to.be.eq(7);
            expect((await rewardsHelper.getPendingStakers(runner.address)).length).to.be.eq(0);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
        });

        it('indexerCatchup with end pending changes', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            //move to Era8
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('2'));
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            expect(await eraManager.eraNumber()).to.be.eq(8);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(7);
            expect(await rewardsStaking.getLastSettledEra(runner.address)).to.be.eq(7);
            expect((await rewardsHelper.getPendingStakers(runner.address)).length).to.be.eq(0);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(100000);
        });

        it('indexerCatchup with unregistered indexer', async () => {
            expect(await eraManager.eraNumber()).to.be.eq(2);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('2'));
            await indexerRegistry.connect(runner).setCommissionRate(200);
            //move to Era13
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            // await serviceAgreementExtra.clearAllEndedAgreements(runner.address);
            await projectRegistry.connect(runner).stopService(DEPLOYMENT_ID);
            await rewardsHelper.indexerCatchup(runner.address);
            await indexerRegistry.connect(runner).unregisterIndexer({ gasLimit: '1000000' });
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            expect(await eraManager.eraNumber()).to.be.eq(13);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(12);
            expect(await rewardsStaking.getLastSettledEra(runner.address)).to.be.eq(12);
            expect((await rewardsHelper.getPendingStakers(runner.address)).length).to.be.eq(0);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).undelegate(runner.address, etherParse('2'));
        });

        it('claim 0 reward should fail', async () => {
            await expect(rewardsDistributor.connect(delegator).claim(runner.address)).to.be.revertedWith('RD007');
        });

        // it('claim each era should get same rewards with claim once', async () => {
        //     //move to Era 3
        //     await startNewEra(eraManager);
        //     await rewardsDistributor.collectAndDistributeRewards(runner.address);
        //     //move to Era 4
        //     await startNewEra(eraManager);
        //     await rewardsDistributor.collectAndDistributeRewards(runner.address);
        //     //move to Era 5
        //     await startNewEra(eraManager);
        //     await rewardsDistributor.collectAndDistributeRewards(runner.address);
        //     await rewardsDistributor.connect(runner).claim(runner.address);
        //     expect((await token.balanceOf(runner.address)).div(1e14)).to.be.eq(rewards);
        // });

        it('delegatior should be able to delegate and apply at next Era', async () => {
            let pendingStakers;

            //delegate
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            pendingStakers = await rewardsHelper.getPendingStakers(runner.address);
            expect(pendingStakers[0]).to.equal(delegator.address);

            // apply stake change
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            pendingStakers = await rewardsHelper.getPendingStakers(runner.address);
            expect(pendingStakers.length).to.equal(0);
            expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.eq(etherParse('1001'));

            //claim no reward for this era
            await expect(rewardsDistributor.connect(delegator).claim(runner.address)).to.be.revertedWith('RD007');
            expect(await token.balanceOf(delegator.address)).to.be.eq(etherParse('9'));

            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            //claim 30 rewards for this era
            await rewardsDistributor.connect(delegator).claim(runner.address);
            expect(await token.balanceOf(delegator.address)).to.be.eq(etherParse('9.000449550449'));
        });

        it('batch claim should work', async () => {
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsDistributor.collectAndDistributeRewards(root.address);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator).delegate(root.address, etherParse('1'));

            // apply stake change
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsDistributor.collectAndDistributeRewards(root.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            await rewardsStaking.applyStakeChange(root.address, delegator.address);

            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsDistributor.collectAndDistributeRewards(root.address);

            await rewardsHelper.batchClaim(delegator.address, [root.address, runner.address]);
            expect(await token.balanceOf(delegator.address)).to.be.eq(etherParse('8.000899100898'));
        });

        it('delegatior should be able to delegate to collectAndDistributeRewards of last Era', async () => {
            //move to ear3
            await startNewEra(eraManager);
            //for now only era2 rewards not be distributed

            //delegatior delegate 1000 SQT
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(1);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(2);
        });

        it('delegate at more then one Era reward not be distributed should fail', async () => {
            //move to ear3
            await startNewEra(eraManager);
            //move to era4
            await startNewEra(eraManager);
            //for now era2 and era3 rewards not be distributed
            await expect(
                stakingManager.connect(delegator).delegate(runner.address, etherParse('1'))
            ).to.be.revertedWith('RS002');
        });

        it('StakeChange should apply after collectAndDistributeRewards', async () => {
            //move to ear3
            await startNewEra(eraManager);
            //distribute era2
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            //delegatior delegate 1000 SQT
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));

            //move to era4
            await startNewEra(eraManager);
            //distribute era3
            await expect(rewardsStaking.applyStakeChange(runner.address, delegator.address)).to.be.revertedWith(
                'RS006'
            );
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.eq(etherParse('1001'));
        });

        it('claimAndDistributeRewards before applyStakeChange should fail', async () => {
            //move to ear3
            await startNewEra(eraManager);
            //distribute era2
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            //delegatior delegate 1000 SQT
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));

            //move to era4
            await startNewEra(eraManager);
            //move to era5
            await startNewEra(eraManager);
            //distribute era3
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            //not apply the change happened in era3， distribute era4
            await expect(rewardsDistributor.collectAndDistributeRewards(runner.address)).to.be.revertedWith('RD005');
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.eq(etherParse('1001'));
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            expect((await rewardsDistributor.getRewardInfo(runner.address)).lastClaimEra).to.be.eq(4);
        });

        it('applyStakeChange should claim accrued rewrads for delegator', async () => {
            //delegate
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            //apply stake Change
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            //delegate
            await startNewEra(eraManager);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            //apply stake Change and claim accrued rewrads for delegator
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            expect(await token.balanceOf(delegator.address)).to.be.eq(etherParse('8.000899100898'));
        });

        it('indexer should be able to change and apply commission rate', async () => {
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyICRChange(runner.address);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
        });

        it('early apply commission rate should fail', async () => {
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await expect(rewardsStaking.applyICRChange(runner.address)).to.be.revertedWith('RS005');
        });

        it('not apply commission rate should fail', async () => {
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await expect(rewardsDistributor.collectAndDistributeRewards(runner.address)).to.be.revertedWith('RD005');
            await rewardsStaking.applyICRChange(runner.address);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
        });

        it('stake and ICR change should be able to happen at same Era', async () => {
            await indexerRegistry.connect(runner).setCommissionRate(200);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await expect(rewardsDistributor.collectAndDistributeRewards(runner.address)).to.be.revertedWith('RD005');
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await expect(rewardsDistributor.collectAndDistributeRewards(runner.address)).to.be.revertedWith('RD005');
            await rewardsStaking.applyICRChange(runner.address);
            expect(await rewardsStaking.getCommissionRate(runner.address)).to.be.eq(200);
        });
    });

    describe('Indexer reregister', () => {
        beforeEach(async () => {
            //setup era period be 15 days
            await eraManager.connect(root).updateEraPeriod(time.duration.days(15).toString());
            //add a delegator delegate to the indexer -> start new era and apply staking change
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            //generate agreement and agreement complete
            await acceptPlan(runner, consumer, 5, etherParse('3'), DEPLOYMENT_ID, token, planManager);
            await timeTravel(6);
            await startNewEra(eraManager);
            // await serviceAgreementExtra.clearAllEndedAgreements(runner.address);
            await projectRegistry.connect(runner).stopService(DEPLOYMENT_ID);
            //unregister indexer
            await indexerRegistry.connect(runner).unregisterIndexer({ gasLimit: '1000000' });
        });

        it('check reward distribution after indexer unregistered', async () => {
            // 1. start new era -> collectAndDistributeRewards -> check values change
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await checkValues(etherParse('0'), etherParse('9'), etherParse('1001'), etherParse('0'));
            // 2. apply indexer stake change -> check values change
            await rewardsStaking.applyStakeChange(runner.address, runner.address);
            await checkValues(etherParse('2.697302697'), etherParse('9'), etherParse('1'), etherParse('0'));
            // 3. delegator undelgate all Tokens
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            // 4. start new era -> delegator apply stake change -> check values change
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await rewardsStaking.applyStakeChange(runner.address, delegator.address);
            await checkValues(etherParse('2.697302697'), etherParse('9.002697302697'), 0, 0);
            // 5. indexer and delegator widthdraw, check values change
            await stakingManager.connect(runner).widthdraw();
            await stakingManager.connect(delegator).widthdraw();
            await checkValues(etherParse('1001.997002697'), etherParse('10.001697302697'), 0, 0);
        });

        it('indexer can not reregister with existing delegators ', async () => {
            // 1. indexer try to reregister immediately should revert with `Last unregistry not settled`: era[n]
            await expect(
                indexerRegistry
                    .connect(runner)
                    .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' })
            ).to.be.revertedWith('RS001');
            // 2. start new era -> indexer `collectAndDistributeRewards` -> `applyStakeChange`: era[n+1]
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);

            // 3. check totalStakingAmount equal delegation amount
            expect(await rewardsStaking.getTotalStakingAmount(runner.address)).to.be.eq(
                await rewardsStaking.getDelegationAmount(delegator.address, runner.address)
            );
            // 4. indexer try to register still revert with `Last unregistry not settled`
            await expect(
                indexerRegistry
                    .connect(runner)
                    .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' })
            ).to.be.revertedWith('RS001');
            // 5. delegator undelegate all the Tokens
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            // 6. indexer try to register revert with `Last unregistry not settled`
            await expect(
                indexerRegistry
                    .connect(runner)
                    .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' })
            ).to.be.revertedWith('RS001');
        });

        it('indexer without delegators can reregister', async () => {
            // 1. start new era -> delegator undelegate -> indexer `collectAndDistributeRewards` -> `applyStakeChange`: era[n+1]
            await startNewEra(eraManager);
            // 2. delegator undelegate all the Tokens
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            // 3. start new era -> delegator -> `applyStakeChange`
            await startNewEra(eraManager);
            await rewardsHelper.connect(runner).indexerCatchup(runner.address);
            // 4. check totalStakingAmount equal 0, era reward equal 0
            await checkValues(etherParse('2.697302697'), etherParse('9.002697302697'), 0, 0);
            // 5. indexer register successfully
            await stakingManager.connect(runner).widthdraw();
            await token.connect(runner).increaseAllowance(staking.address, etherParse('1000'));
            await staking.reflectEraUpdate(runner.address, runner.address);
            await indexerRegistry
                .connect(runner)
                .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' });
        });

        it('reward distribution should work after indexer reregister immediately', async () => {
            // 1. delegator undelegate all the tokens
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            // 2. start new era -> indexer `collectAndDistributeRewards` -> `applyStakeChange | delegator -> `applyStakeChange`
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await stakingManager.connect(runner).widthdraw();
            await stakingManager.connect(delegator).widthdraw();
            // 3. indexer reregister -> add previous delegator and a new delegator
            await staking.reflectEraUpdate(runner.address, runner.address);
            await token.connect(runner).increaseAllowance(staking.address, etherParse('1000'));
            await indexerRegistry
                .connect(runner)
                .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' });
            await checkValues(
                etherParse('1.997002697'),
                etherParse('10.001697302697'),
                etherParse('1000'),
                etherParse('0')
            );
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('1'));
            await projectRegistry.connect(runner).startService(DEPLOYMENT_ID);
            // 4. generate new agreement and check the reward distribution for 2 era
            await acceptPlan(runner, consumer, 5, etherParse('3'), DEPLOYMENT_ID, token, planManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await rewardsDistributor.connect(runner).claim(runner.address);
            await checkValues(
                etherParse('4.996702697'),
                etherParse('9.001697302697'),
                etherParse('1002'),
                etherParse('3')
            );
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await checkValues(etherParse('4.996702697'), etherParse('9.001697302697'), etherParse('1002'), 0);
        });

        it('reward distribution should work after indexer reregister few more ears later', async () => {
            // 1. delegator undelegate all the tokens
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('1'));
            // 2. start new era -> indexer `collectAndDistributeRewards` -> `applyStakeChange | delegator -> `applyStakeChange`
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await stakingManager.connect(runner).widthdraw();
            await stakingManager.connect(delegator).widthdraw();
            //after few more eras
            await startNewEra(eraManager);
            await startNewEra(eraManager);
            // 3. indexer reregister -> add previous delegator and a new delegator
            await staking.reflectEraUpdate(runner.address, runner.address);
            await token.connect(runner).increaseAllowance(staking.address, etherParse('1000'));
            await indexerRegistry
                .connect(runner)
                .registerIndexer(etherParse('1000'), METADATA_HASH, 100, { gasLimit: '2000000' });
            await checkValues(etherParse('1.997002697'), etherParse('10.001697302697'), etherParse('1000'), 0);
            await stakingManager.connect(delegator).delegate(runner.address, etherParse('1'));
            await stakingManager.connect(delegator2).delegate(runner.address, etherParse('1'));
            await projectRegistry.connect(runner).startService(DEPLOYMENT_ID);
            // 4. generate new agreement and check the reward distribution for 2 era
            await acceptPlan(runner, consumer, 5, etherParse('3'), DEPLOYMENT_ID, token, planManager);
            await startNewEra(eraManager);
            await rewardsHelper.indexerCatchup(runner.address);
            await rewardsDistributor.connect(runner).claim(runner.address);
            await checkValues(
                etherParse('4.996702697'),
                etherParse('9.001697302697'),
                etherParse('1002'),
                etherParse('3')
            );
            await startNewEra(eraManager);
            await rewardsDistributor.collectAndDistributeRewards(runner.address);
            await checkValues(etherParse('4.996702697'), etherParse('9.001697302697'), etherParse('1002'), 0);
        });

        it('undelgate and redelegate after indexer unregistered should work', async () => {
            // 1. delegator can undelegate from the indexer (some amount) at the same era of indexer unregistered
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('0.1'));
            // 2. start new era
            await startNewEra(eraManager);
            // 3. delegator can not undelegate from the indexer directly after indexer unregistered
            await stakingManager.connect(delegator).undelegate(runner.address, etherParse('0.1'));
        });
    });
});
